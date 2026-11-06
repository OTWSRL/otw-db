import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ConnectionError, DbAdminError, QueryError } from '../errors.ts'
import type {
  ApplyResult,
  Capabilities,
  Change,
  Column,
  Driver,
  QueryOptions,
  QueryResult,
  ResultSet,
  RowsRequest,
  ServerInfo,
  TableDetail,
  TableSummary,
} from '../types.ts'
import {
  changeStatement,
  doubleQuote,
  orderBy,
  Parameters,
  where,
  whole,
  type Dialect,
} from './sql.ts'

/** A value as a SQLite literal, for statements shown to people and SQL exports. */
export function sqliteLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  return `'${value.replaceAll("'", "''")}'`
}

const dialect: Dialect = {
  identifier: doubleQuote,
  literal: sqliteLiteral,
  placeholder: () => '?',
  text: (expression) => `CAST(${expression} AS TEXT)`,
  // SQLite's LIKE ignores case for ASCII letters, and has no escape until told.
  ilike: 'LIKE',
  likeEscapeChar: '\\',
  likeEscape: " ESCAPE '\\'",
  inList: (expression, values, parameter) =>
    `${expression} IN (${values.map(parameter).join(', ')})`,
  insertDefaults: 'DEFAULT VALUES',
}

const EXPORT_BATCH = 1_000

/**
 * Where `sql`'s first statement ends, and whether anything but space and comments follows it.
 * SQLite prepares the first statement and ignores the rest, so the rest is refused here instead.
 * Self-contained: it's also copied into the worker.
 */
function hasMoreStatements(sql: string): boolean {
  let i = 0
  const n = sql.length
  let first = true
  while (i < n) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? n : end + 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2
          else break
        } else j++
      }
      i = j + 1
    } else if (c === ';') {
      first = false
      i++
    } else if (/\s/.test(c!)) {
      i++
    } else {
      if (!first) return true
      i++
    }
  }
  return false
}

/** The worker's code: runs on its own thread, so a long statement never blocks the host. */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
${hasMoreStatements.toString()}
let reader, writer
const cursors = new Map()
let nextCursor = 1
const db = (write) =>
  write ? (writer ??= new DatabaseSync(workerData.path)) : (reader ??= new DatabaseSync(workerData.path, { readOnly: true }))

function text(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number') return String(value)
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString('hex').toUpperCase() + "'"
  return String(value)
}

function prepare(database, sql) {
  if (hasMoreStatements(sql)) {
    const error = new Error('One statement at a time: run the others separately.')
    error.oneStatement = true
    throw error
  }
  const statement = database.prepare(sql)
  statement.setReadBigInts(true)
  if (statement.setReturnArrays) statement.setReturnArrays(true)
  return statement
}

function columnsOf(statement) {
  return statement.columns().map((c) => ({ name: c.name, type: (c.type || 'any').toLowerCase() }))
}

function row(statement, columns, value) {
  return Array.isArray(value) ? value.map(text) : columns.map((c) => text(value[c.name]))
}

function run({ sql, params, maxRows, write, transaction }) {
  const database = db(write)
  const statement = prepare(database, sql)
  const columns = columnsOf(statement)
  if (!columns.length) {
    if (transaction) database.exec('BEGIN')
    try {
      const { changes } = statement.run(...params)
      if (transaction) database.exec('COMMIT')
      return { columns, rows: [], truncated: false, changes: Number(changes) }
    } catch (error) {
      if (transaction && database.isTransaction) database.exec('ROLLBACK')
      throw error
    }
  }
  const rows = []
  let truncated = false
  for (const value of statement.iterate(...params)) {
    if (rows.length === maxRows) {
      truncated = true
      break
    }
    rows.push(row(statement, columns, value))
  }
  return { columns, rows, truncated, changes: null }
}

function apply({ statements }) {
  const database = db(true)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const { sql, params, oneRow, shown } of statements) {
      const { changes } = prepare(database, sql).run(...params)
      if (oneRow && Number(changes) !== 1) {
        const error = new Error(Number(changes) === 0 ? 'its row is gone or its key changed' : 'its key matched ' + changes + ' rows')
        error.conflict = shown
        throw error
      }
    }
    database.exec('COMMIT')
    return {}
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

function open({ sql, params }) {
  const statement = prepare(db(false), sql)
  const columns = columnsOf(statement)
  const id = nextCursor++
  cursors.set(id, { statement, columns, iterator: statement.iterate(...params) })
  return { cursor: id, columns }
}

function next({ cursor, count }) {
  const state = cursors.get(cursor)
  const rows = []
  let done = false
  while (rows.length < count) {
    const step = state.iterator.next()
    if (step.done) {
      done = true
      break
    }
    rows.push(row(state.statement, state.columns, step.value))
  }
  if (done) cursors.delete(cursor)
  return { rows, done }
}

function close({ cursor }) {
  cursors.get(cursor)?.iterator.return?.()
  cursors.delete(cursor)
  return {}
}

const handlers = { run, apply, open, next, close }
parentPort.on('message', (message) => {
  try {
    parentPort.postMessage({ id: message.id, result: handlers[message.type](message) })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: {
        message: error.message,
        code: error.code,
        errcode: error.errcode,
        conflict: error.conflict,
        oneStatement: error.oneStatement === true,
      },
    })
  }
})
`

interface WorkerError {
  message: string
  code?: string
  errcode?: number
  conflict?: string
  oneStatement?: boolean
}

/** The file a `sqlite:` or `file:` address names. */
export function sqlitePath(url: string): string {
  let path = url.replace(/^(sqlite|file):/i, '')
  // sqlite:///var/db.sqlite and file:///var/db.sqlite are absolute; sqlite:./db.sqlite relative.
  if (path.startsWith('//')) path = path.slice(2)
  path = decodeURIComponent(path.split('?')[0]!)
  if (!path || path === ':memory:') {
    throw new DbAdminError(
      'A SQLite connection names a file; an in-memory database has nothing to show.',
      400,
      'bad-request',
    )
  }
  return resolve(path)
}

/**
 * A SQLite driver for the file `url` names, on Node's own node:sqlite. Statements run one at a
 * time on a worker thread: a long one never blocks the host, and stopping the worker stops it.
 * Read access opens the file read-only.
 */
export function sqliteDriver(url: string): Driver {
  return new SqliteDriver(sqlitePath(url))
}

class SqliteDriver implements Driver {
  readonly kind = 'sqlite'
  readonly capabilities: Capabilities = { schemas: false, transactionalDdl: true, cancel: true }
  readonly sql = { identifier: doubleQuote, literal: sqliteLiteral }
  readonly #path: string
  #worker: Worker | null = null
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #next = 1
  /** One request at a time: the worker's connection is single-threaded. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
  }

  #spawn(): Worker {
    if (this.#worker) return this.#worker
    if (!existsSync(this.#path))
      throw new ConnectionError(`There's no SQLite database at ${this.#path}.`)
    const worker = new Worker(WORKER, { eval: true, workerData: { path: this.#path } })
    worker.on(
      'message',
      ({ id, result, error }: { id: number; result?: unknown; error?: WorkerError }) => {
        const waiting = this.#pending.get(id)
        this.#pending.delete(id)
        if (!waiting) return
        if (error) waiting.reject(fromWorker(error))
        else waiting.resolve(result)
      },
    )
    const fail = (error: Error) => {
      for (const waiting of this.#pending.values()) waiting.reject(error)
      this.#pending.clear()
      if (this.#worker === worker) this.#worker = null
    }
    worker.on('error', (error) =>
      fail(new ConnectionError(`The SQLite worker failed: ${error.message}`)),
    )
    worker.on('exit', () => fail(new ConnectionError('The SQLite worker stopped.')))
    this.#worker = worker
    return worker
  }

  /**
   * Sends a request when the ones before it are done. The timer and the signal stop the worker,
   * which stops the statement; the next request starts a fresh one.
   */
  #send<T>(
    message: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (options.signal?.aborted)
        throw new DbAdminError('The query was canceled.', 409, 'canceled')
      const worker = this.#spawn()
      const id = this.#next++
      return new Promise<T>((resolve, reject) => {
        let stopped: Error | null = null
        const stop = (error: Error) => {
          if (stopped) return
          stopped = error
          this.#pending.delete(id)
          this.#worker = null
          void worker.terminate()
          reject(error)
        }
        const timer = options.timeoutMs
          ? setTimeout(
              () =>
                stop(
                  new QueryError(
                    `The statement ran past its ${options.timeoutMs} ms limit and was stopped.`,
                    'SQLITE_INTERRUPT',
                  ),
                ),
              options.timeoutMs,
            )
          : undefined
        const abort = () => stop(new DbAdminError('The query was canceled.', 409, 'canceled'))
        options.signal?.addEventListener('abort', abort, { once: true })
        const done = () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
        }
        this.#pending.set(id, {
          resolve: (value) => {
            done()
            resolve(value as T)
          },
          reject: (error) => {
            done()
            reject(error)
          },
        })
        worker.postMessage({ ...message, id })
      })
    }
    const result = this.#queue.then(run, run)
    this.#queue = result.catch(() => {})
    return result
  }

  #run(
    sql: string,
    params: unknown[],
    options: {
      maxRows: number
      write: boolean
      timeoutMs: number
      signal?: AbortSignal
      transaction?: boolean
    },
  ) {
    return this.#send<{
      columns: { name: string; type: string }[]
      rows: (string | null)[][]
      truncated: boolean
      changes: number | null
    }>(
      {
        type: 'run',
        sql,
        params,
        maxRows: options.maxRows,
        write: options.write,
        transaction: options.transaction ?? false,
      },
      options,
    )
  }

  #catalog(sql: string, params: unknown[] = []) {
    return this.#run(sql, params, { maxRows: 100_000, write: false, timeoutMs: 30_000 }).then(
      (r) => r.rows,
    )
  }

  async tables(): Promise<TableSummary[]> {
    const databases = (await this.#catalog('PRAGMA database_list'))
      .map((r) => r[1]!)
      .filter((d) => d !== 'temp')
    const tables: TableSummary[] = []
    for (const schema of databases) {
      const rows = await this.#catalog(
        `SELECT name, type FROM ${doubleQuote(schema)}.sqlite_schema
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
      )
      for (const [name, type] of rows) {
        tables.push({
          schema,
          name: name!,
          kind: type === 'view' ? 'view' : 'table',
          estimatedRows: null,
          bytes: null,
        })
      }
    }
    return tables
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const at = doubleQuote(schema)
    const [found] = await this.#catalog(
      `SELECT type FROM ${at}.sqlite_schema WHERE name = ? AND type IN ('table', 'view')`,
      [name],
    )
    if (!found) return null
    const table = doubleQuote(name)
    const columns = await this.#catalog(`PRAGMA ${at}.table_xinfo(${table})`)
    const indexes = await this.#catalog(`PRAGMA ${at}.index_list(${table})`)
    const keys = await this.#catalog(`PRAGMA ${at}.foreign_key_list(${table})`)
    const created = new Map(
      (
        await this.#catalog(
          `SELECT name, sql FROM ${at}.sqlite_schema WHERE type = 'index' AND tbl_name = ?`,
          [name],
        )
      ).map((r) => [r[0]!, r[1]]),
    )
    const definitions = []
    for (const [, index, unique, origin] of indexes) {
      const parts = (await this.#catalog(`PRAGMA ${at}.index_info(${doubleQuote(index!)})`)).map(
        (r) => doubleQuote(r[2]!),
      )
      definitions.push({
        name: index!,
        definition:
          created.get(index!) ??
          `${origin === 'pk' ? 'PRIMARY KEY' : unique === '1' ? 'UNIQUE' : 'INDEX'} (${parts.join(', ')})`,
      })
    }
    const foreign = new Map<string, (string | null)[][]>()
    for (const key of keys) foreign.set(key[0]!, [...(foreign.get(key[0]!) ?? []), key])
    // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden (2 virtual, 3 stored).
    const visible = columns.filter((c) => c[6] !== '1')
    const primaryKey = visible
      .filter((c) => c[5] !== '0')
      .sort((a, b) => Number(a[5]) - Number(b[5]))
      .map((c) => c[1]!)
    return {
      schema,
      name,
      kind: found[0] === 'view' ? 'view' : 'table',
      estimatedRows: null,
      bytes: null,
      comment: null,
      columns: visible.map((c): Column => ({
        name: c[1]!,
        type: (c[2] || 'any').toLowerCase(),
        nullable: c[3] === '0' && c[5] === '0',
        default: c[4] ?? null,
        generated:
          c[6] === '2'
            ? 'virtual'
            : c[6] === '3'
              ? 'stored'
              : primaryKey.length === 1 && c[1] === primaryKey[0] && /^integer$/i.test(c[2] ?? '')
                ? 'by default'
                : null,
        comment: null,
      })),
      primaryKey,
      indexes: definitions,
      foreignKeys: [...foreign.values()].map((group) => ({
        name: `fk_${name}_${group[0]![0]}`,
        definition: `FOREIGN KEY (${group.map((k) => doubleQuote(k[3]!)).join(', ')}) REFERENCES ${doubleQuote(group[0]![2]!)}(${group.map((k) => doubleQuote(k[4] ?? 'rowid')).join(', ')})`,
      })),
      // SQLite keeps CHECK constraints inside the table's CREATE statement only.
      checks: [],
    }
  }

  async rows(
    { schema, table, limit, offset, order = [], filters = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${doubleQuote(schema)}.${doubleQuote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)} LIMIT ${whole(limit) + 1} OFFSET ${whole(offset)}`
    const started = performance.now()
    const result = await this.#run(sql, parameters.values, {
      ...options,
      maxRows: limit,
      write: false,
    })
    return {
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      durationMs: Math.round(performance.now() - started),
    }
  }

  async count(
    { schema, table, filters = [] }: Pick<RowsRequest, 'schema' | 'table' | 'filters'>,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<number> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT count(*) FROM ${doubleQuote(schema)}.${doubleQuote(table)}${where(dialect, filters, parameters)}`
    const { rows } = await this.#run(sql, parameters.values, {
      ...options,
      maxRows: 1,
      write: false,
    })
    return Number(rows[0]![0])
  }

  async info(): Promise<ServerInfo> {
    const [[version]] = (await this.#catalog('SELECT sqlite_version()')) as [[string]]
    return { product: 'SQLite', version, database: basename(this.#path), user: '' }
  }

  /**
   * One statement: read access on a read-only handle to the file, write access in a transaction,
   * or alone where SQLite refuses one (VACUUM).
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const started = performance.now()
    const write = options.access === 'write'
    const run = (transaction: boolean) => this.#run(sql, [], { ...options, write, transaction })
    let result
    try {
      result = await run(write)
    } catch (error) {
      if (!write || !/within a transaction/i.test((error as Error).message)) throw error
      result = await run(false)
    }
    const command = (
      /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(\w+)/.exec(sql)?.[1] ?? ''
    ).toUpperCase()
    return {
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      command,
      affectedRows: result.changes ?? (result.truncated ? null : result.rows.length),
      durationMs: Math.round(performance.now() - started),
    }
  }

  async apply(
    { schema, table }: { schema: string; table: string },
    changes: readonly Change[],
    { timeoutMs, dryRun = false }: { timeoutMs: number; dryRun?: boolean },
  ): Promise<ApplyResult> {
    const target = `${doubleQuote(schema)}.${doubleQuote(table)}`
    const statements = changes.map((change) => changeStatement(dialect, target, change))
    const shown = statements.map((s) => s.shown)
    if (dryRun) return { statements: shown, applied: false }
    await this.#send(
      {
        type: 'apply',
        statements: statements.map((s) => ({
          sql: s.text,
          params: s.values,
          oneRow: s.oneRow,
          shown: s.shown,
        })),
      },
      { timeoutMs },
    )
    return { statements: shown, applied: true }
  }

  async *export(
    {
      schema,
      table,
      filters = [],
      order = [],
    }: Pick<RowsRequest, 'schema' | 'table' | 'filters' | 'order'>,
    { timeoutMs }: { timeoutMs: number },
  ): AsyncGenerator<{ columns: { name: string }[]; rows: (string | null)[][] }> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${doubleQuote(schema)}.${doubleQuote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    const { cursor, columns } = await this.#send<{ cursor: number; columns: { name: string }[] }>(
      { type: 'open', sql, params: parameters.values },
      { timeoutMs },
    )
    let done = false
    try {
      for (let first = true; !done; first = false) {
        const batch = await this.#send<{ rows: (string | null)[][]; done: boolean }>(
          { type: 'next', cursor, count: EXPORT_BATCH },
          { timeoutMs },
        )
        done = batch.done
        if (batch.rows.length || first) yield { columns, rows: batch.rows }
      }
    } finally {
      if (!done) await this.#send({ type: 'close', cursor }).catch(() => {})
    }
  }

  async close(): Promise<void> {
    const worker = this.#worker
    this.#worker = null
    await this.#queue
    await worker?.terminate()
  }
}

/** The worker's errors as the API's. */
function fromWorker(error: WorkerError): Error {
  if (error.conflict)
    return new DbAdminError(
      `Nothing was saved: ${error.message}.\n${error.conflict}`,
      409,
      'conflict',
    )
  if (error.oneStatement) return new DbAdminError(error.message, 400, 'one-statement')
  if (error.errcode !== undefined || error.code === 'ERR_SQLITE_ERROR')
    return new QueryError(error.message, error.code)
  return new ConnectionError(`SQLite failed: ${error.message}`)
}
