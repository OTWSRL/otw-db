import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ConnectionError, DbAdminError, QueryError } from '../errors.ts'
import type {
  ApplyResult,
  Capabilities,
  Change,
  ExportColumn,
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
  EXPORT_IDLE_MS,
  orderBy,
  Parameters,
  refuseChanged,
  stalledExport,
  where,
  whole,
  type Dialect,
} from './sql.ts'

/** A value as a SQLite literal, for statements shown to people and SQL exports. */
export function sqliteLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Bytes as the grid shows them, `X'1F'`, as the literal that is those bytes; null for anything
 * else. SQLite never finds a blob equal to text, so a blob key compared with those letters
 * matches no row.
 */
export function sqliteBytes(shown: string): string | null {
  const hex = /^X'((?:[0-9A-Fa-f]{2})*)'$/.exec(shown)?.[1]
  return hex === undefined ? null : `X'${hex.toUpperCase()}'`
}

const dialect: Dialect = {
  identifier: doubleQuote,
  literal: sqliteLiteral,
  bytes: sqliteBytes,
  // A write transaction here holds the whole file.
  forUpdate: '',
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

/**
 * PRAGMAs that set something for the whole process, not for the connection they're run on: with
 * `hard_heap_limit = 1`, no SQLite handle in the process can read a row again, the host's own
 * included, until it restarts.
 */
const PROCESS_WIDE = [
  'hard_heap_limit',
  'soft_heap_limit',
  'temp_store_directory',
  'data_store_directory',
  // Not the process's, but another file's: where Apple's SQLite keeps a lock, made if missing.
  'lock_proxy_file',
]

/** A statement's first word in capitals, past spaces and comments, read a character at a time. */
function sqliteFirstWord(sql: string): string {
  let at = 0
  for (;;) {
    while (at < sql.length && /\s/.test(sql[at]!)) at++
    if (sql.startsWith('--', at)) {
      const end = sql.indexOf('\n', at)
      at = end === -1 ? sql.length : end + 1
    } else if (sql.startsWith('/*', at)) {
      const end = sql.indexOf('*/', at + 2)
      at = end === -1 ? sql.length : end + 2
    } else break
  }
  return (/^\w+/.exec(sql.slice(at, at + 64))?.[0] ?? '').toUpperCase()
}

/**
 * The one of those a statement would set, by its tokens: past comments, EXPLAIN [QUERY PLAN] (a
 * PRAGMA acts when it's prepared, explained or not) and a schema's name, however the name is
 * quoted. Null for any other statement, and for a PRAGMA that only reads. Self-contained.
 */
export function processWidePragma(sql: string): string | null {
  let at = 0
  const skip = () => {
    for (;;) {
      while (at < sql.length && /\s/.test(sql[at]!)) at++
      if (sql.startsWith('--', at)) {
        const end = sql.indexOf('\n', at)
        at = end === -1 ? sql.length : end + 1
      } else if (sql.startsWith('/*', at)) {
        const end = sql.indexOf('*/', at + 2)
        at = end === -1 ? sql.length : end + 2
      } else return
    }
  }
  const name = (): string | null => {
    skip()
    const open = sql[at]
    const close = open === '[' ? ']' : open === '"' || open === '`' || open === "'" ? open : null
    if (close) {
      const end = sql.indexOf(close, at + 1)
      if (end === -1) return null
      const quoted = sql.slice(at + 1, end)
      at = end + 1
      return quoted.toLowerCase()
    }
    const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(at, at + 64))?.[0]
    if (!word) return null
    at += word.length
    return word.toLowerCase()
  }
  let word = name()
  if (word === 'explain') {
    word = name()
    if (word === 'query') {
      name()
      word = name()
    }
  }
  if (word !== 'pragma') return null
  let pragma = name()
  skip()
  if (sql[at] === '.') {
    at++
    pragma = name()
    skip()
  }
  if (!pragma || !PROCESS_WIDE.includes(pragma)) return null
  return sql[at] === '=' || sql[at] === '(' ? pragma : null
}

/**
 * The worker's code, for a thread or a process of its own: `parentPort` and `workerData` are
 * given by whichever of the two openings below it runs after.
 */
const WORKER_BODY = `
const { DatabaseSync, constants } = require('node:sqlite')
const PROCESS_WIDE = ${JSON.stringify(PROCESS_WIDE)}
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

// Someone's own SQL runs on a handle of its own, closed after it: what the statement sets up (a
// TEMP view named as a table is, a PRAGMA, a transaction left open) ends with it, and never
// reaches the next person's statement, the grid's reads and edits, or the host's file.
function run(message) {
  if (!message.own) return runOn(db(message.write), message)
  const database = new DatabaseSync(workerData.path, { readOnly: !message.write })
  // Behind the driver's reading of the statement, where this Node has it: SQLite itself says
  // which PRAGMA a statement sets, whatever its text.
  if (database.setAuthorizer && constants && constants.SQLITE_PRAGMA !== undefined) {
    database.setAuthorizer((action, name, value) =>
      action === constants.SQLITE_PRAGMA && value != null && PROCESS_WIDE.includes(String(name).toLowerCase())
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK)
  }
  try {
    return runOn(database, message)
  } finally {
    database.close()
  }
}

function runOn(database, { sql, params, maxRows, transaction }) {
  const statement = prepare(database, sql)
  const columns = columnsOf(statement)
  if (!columns.length) {
    if (transaction) database.exec('BEGIN')
    try {
      const { changes } = statement.run(...params)
      if (transaction) database.exec('COMMIT')
      else if (database.isTransaction) {
        // BEGIN or SAVEPOINT, run alone: nothing after it would ever commit.
        const error = new Error('a transaction left open')
        error.leftOpen = true
        throw error
      }
      return { columns, rows: [], truncated: false, changes: Number(changes) }
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK')
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
    for (const [index, { sql, params, oneRow, shown, check }] of statements.entries()) {
      if (check) {
        // The cells as the grid read them, for the driver to compare with what they held.
        const reader = prepare(database, check.sql)
        const columns = columnsOf(reader)
        let current = null
        for (const value of reader.iterate(...check.params)) {
          current = row(reader, columns, value)
          break
        }
        if (!current || check.original.some((was, i) => was !== current[i])) {
          const error = new Error('a cell was changed meanwhile')
          error.changed = { index, current }
          throw error
        }
      }
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

// A write killed part-way (its process, at its time limit) can leave its journal beside the
// file: the next handle that may write undoes it, and one that may only read can't, and fails.
function recover() {
  db(true).prepare('SELECT count(*) FROM sqlite_master').get()
  return true
}

const handlers = { run, apply, open, next, close, recover }
// A read that finds a journal left by a writer that was killed (this driver's own, at a time
// limit; the server itself, stopped mid-write) can't undo it, and fails. The journal is undone
// by a handle that may write, and the read is asked again.
function handle(message) {
  try {
    return handlers[message.type](message)
  } catch (error) {
    const hot = /attempt to write a readonly database/i.test(String(error && error.message))
    if (!hot || message.write || message.type === 'apply' || message.type === 'recover') throw error
    try {
      recover()
    } catch {
      throw error
    }
    return handlers[message.type](message)
  }
}

parentPort.on('message', (message) => {
  try {
    parentPort.postMessage({ id: message.id, result: handle(message) })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: {
        message: error.message,
        code: error.code,
        errcode: error.errcode,
        conflict: error.conflict,
        oneStatement: error.oneStatement === true,
        leftOpen: error.leftOpen === true,
        changed: error.changed,
      },
    })
  }
})
`

/** On a thread: a long statement never blocks the host. */
const THREAD_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
${WORKER_BODY}`

/**
 * In a process: for someone's own SQL. A statement can stay inside SQLite for as long as it
 * likes (a recursive query with no end), where nothing stops a thread: stopping the thread stops
 * its JavaScript, and there is none running. A process can be killed, and what it held on the
 * file goes with it.
 *
 * The statement runs on a thread of that process, so its first thread is never inside SQLite:
 * it always hears that the server has gone (stopped, crashed, killed), and ends the process,
 * statement and all. Left to one thread, a statement with no end would outlive the server that
 * asked for it, and keep a processor for itself. Exported for its test.
 */
export const SQLITE_PROCESS_WORKER = `
const { Worker } = require('node:worker_threads')
// Not asked to stop, which waits for the thread: killed, as the server would have.
const die = () => process.kill(process.pid, 'SIGKILL')
process.on('disconnect', die)
const worker = new Worker(${JSON.stringify(THREAD_WORKER)}, {
  eval: true,
  workerData: JSON.parse(process.env.OTW_DB_SQLITE_WORKER),
})
worker.on('message', (message) => {
  try {
    process.send(message)
  } catch {
    die()
  }
})
worker.on('error', die)
worker.on('exit', die)
process.on('message', (message) => worker.postMessage(message))
// Said once the thread is up: a process that never says it can't be waited on for answers.
worker.once('online', () => process.send({ ready: true }))
`

/** What the process is given of the server's environment: where programs and temporary files are. */
const PROCESS_ENV = [
  'PATH',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SQLITE_TMPDIR',
  'HOME',
  'USERPROFILE',
]

/** How long a process with nothing to run is kept before it's let go of. */
const PROCESS_IDLE_MS = 60_000

interface WorkerError {
  message: string
  code?: string
  errcode?: number
  conflict?: string
  oneStatement?: boolean
  leftOpen?: boolean
  /** An update's check found its row changed or gone: which statement, and the row now. */
  changed?: { index: number; current: (string | null)[] | null }
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
export function sqliteDriver(url: string, options: SqliteOptions = {}): Driver {
  return new SqliteDriver(sqlitePath(url), options)
}

/** How the SQLite driver behaves, where the defaults don't suit. */
export interface SqliteOptions {
  /**
   * How long an export may sit between two batches, its rows unread, before it's ended and lets
   * go of the file. Defaults to 5 minutes.
   */
  exportIdleMs?: number
}

/** A worker as a lane holds it, thread or process: told what to run, and stopped. */
interface Running {
  /** Sends it a request, which is its own to answer or to fail. */
  post(message: Record<string, unknown> & { id: number }): void
  /** Stops it now, whatever it's doing; done once it's gone. */
  stop(): Promise<void>
}

/** What a worker sends back: a request's result, or why it has none. */
interface Answer {
  id: number
  result?: unknown
  error?: WorkerError
  /** A process's first word: its thread is up. */
  ready?: true
}

/** How long a process has to say it's up before the lane does without one. */
const PROCESS_START_MS = 5_000

/** This server can't start a process: the lane goes on a thread instead, as it did before. */
class NoProcess extends Error {}

/**
 * A worker of its own with the file open on it, and the requests waiting for it. The driver has
 * one for its statements; each export has another, so stopping a statement (which stops its
 * worker) never ends an export under way, and an export nobody reads can be let go of by
 * stopping its own. Those are threads. Someone's own SQL has a third, a process: see
 * SQLITE_PROCESS_WORKER.
 */
class Lane {
  readonly #path: string
  #kind: 'thread' | 'process'
  #worker: Running | null = null
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #next = 1
  /** One request at a time: the worker's connection is single-threaded. */
  #queue: Promise<unknown> = Promise.resolve()
  #idle: ReturnType<typeof setTimeout> | undefined
  /** The last worker stopped, on its way out. */
  #going: Promise<void> = Promise.resolve()

  constructor(path: string, kind: 'thread' | 'process' = 'thread') {
    this.#path = path
    this.#kind = kind
  }

  #spawn(): Running {
    if (this.#worker) return this.#worker
    if (!existsSync(this.#path))
      throw new ConnectionError(`There's no SQLite database at ${this.#path}.`)
    // The requests this worker was sent: when it goes, those fail, and no others. A worker
    // stopped at a time limit is still on its way out when the next request has a new one.
    const mine = new Set<number>()
    const answer = ({ id, result, error }: Answer) => {
      mine.delete(id)
      const waiting = this.#pending.get(id)
      this.#pending.delete(id)
      if (!waiting) return
      if (error) waiting.reject(fromWorker(error))
      else waiting.resolve(result)
    }
    const fail = (error: Error) => {
      for (const id of mine) {
        this.#pending.get(id)?.reject(error)
        this.#pending.delete(id)
      }
      mine.clear()
      if (this.#worker === running) this.#worker = null
    }
    const sent = (id: number) => void mine.add(id)
    const running: Running =
      this.#kind === 'thread' ? this.#thread(answer, fail, sent) : this.#process(answer, fail, sent)
    this.#worker = running
    return running
  }

  #thread(
    answer: (message: Answer) => void,
    fail: (error: Error) => void,
    sent: (id: number) => void,
  ): Running {
    const worker = new Worker(THREAD_WORKER, { eval: true, workerData: { path: this.#path } })
    worker.on('message', answer)
    worker.on('error', (error) =>
      fail(new ConnectionError(`The SQLite worker failed: ${error.message}`)),
    )
    worker.on('exit', () => fail(new ConnectionError('The SQLite worker stopped.')))
    return {
      post: (message) => {
        sent(message.id)
        worker.postMessage(message)
      },
      stop: async () => void (await worker.terminate()),
    }
  }

  #process(
    answer: (message: Answer) => void,
    fail: (error: Error) => void,
    sent: (id: number) => void,
  ): Running {
    const env: Record<string, string> = {
      OTW_DB_SQLITE_WORKER: JSON.stringify({ path: this.#path }),
    }
    for (const name of PROCESS_ENV)
      if (process.env[name] !== undefined) env[name] = process.env[name]
    let child: ChildProcess
    try {
      child = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '-e', SQLITE_PROCESS_WORKER],
        // Nothing to read or write but what it's sent: its errors go where the server's do.
        {
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          serialization: 'advanced',
          // An app's own types may ask more of an environment (Next's wants NODE_ENV): this one is
          // the process's whole environment, by design.
          env: env as NodeJS.ProcessEnv,
          windowsHide: true,
        },
      )
    } catch (error) {
      throw new NoProcess((error as Error).message)
    }
    const gone = () => child.exitCode !== null || child.signalCode !== null
    // Nothing is sent until the process has said it's up. One that starts and stops at once (a
    // Node that can't run it), or starts and never speaks, is no process to wait on: the lane
    // goes on a thread, as where none starts, and since nothing was sent, nothing runs twice.
    let ready = false
    let deliberate = false
    const unsent: (Record<string, unknown> & { id: number })[] = []
    const starting = setTimeout(() => {
      // Decided after what has already arrived is read: a server too busy to read its messages
      // for a while finds this timer due before the process's first word, which is waiting.
      setImmediate(() => {
        if (!ready && !gone()) child.kill('SIGKILL')
      })
    }, PROCESS_START_MS)
    starting.unref()
    const stopped = () =>
      deliberate || ready
        ? new ConnectionError('The SQLite worker stopped.')
        : new NoProcess('it stopped before it was up')
    child.on('message', (message: Answer) => {
      if (!message.ready) return answer(message)
      ready = true
      clearTimeout(starting)
      for (const waiting of unsent.splice(0)) child.send(waiting)
    })
    child.on('error', (error) => {
      clearTimeout(starting)
      fail(
        child.pid === undefined
          ? new NoProcess(error.message)
          : ready
            ? new ConnectionError(`The SQLite worker failed: ${error.message}`)
            : stopped(),
      )
    })
    child.on('exit', () => {
      clearTimeout(starting)
      fail(stopped())
    })
    return {
      post: (message) => {
        sent(message.id)
        if (!ready) unsent.push(message)
        else if (child.connected) child.send(message)
      },
      stop: () =>
        new Promise<void>((resolve) => {
          // Stopped on purpose is stopped: not a process that couldn't start, to try again without.
          deliberate = true
          clearTimeout(starting)
          if (child.pid === undefined || gone()) return resolve()
          child.once('exit', () => resolve())
          // Not asked: killed. SQLite, mid-statement, hears nothing else.
          child.kill('SIGKILL')
        }),
    }
  }

  /** Runs `work` when the requests before it are done, and holds those after it until it is. */
  after<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work)
    this.#queue = result.catch(() => {})
    return result
  }

  /**
   * Sends a request when the ones before it are done. The timer and the signal stop the worker,
   * which stops the statement; the next request starts a fresh one.
   */
  send<T>(
    message: Record<string, unknown>,
    /** `now`: without waiting its turn, for whoever is already having theirs (`after`). */
    options: { timeoutMs?: number; signal?: AbortSignal; now?: boolean } = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (options.signal?.aborted)
        throw new DbAdminError('The query was canceled.', 409, 'canceled')
      clearTimeout(this.#idle)
      const worker = this.#spawn()
      const id = this.#next++
      return new Promise<T>((resolve, reject) => {
        let stopped: Error | null = null
        let answered = false
        const stop = (error: Error) => {
          if (stopped || answered) return
          stopped = error
          this.#pending.delete(id)
          this.#worker = null
          this.#going = worker.stop().catch(() => {})
          reject(error)
        }
        const timer = options.timeoutMs
          ? setTimeout(
              () =>
                // After what has already arrived is read: a statement that finished while the
                // server was too busy to hear it isn't stopped, and said to have been.
                setImmediate(() =>
                  stop(
                    new QueryError(
                      `The statement ran past its ${options.timeoutMs} ms limit and was stopped.`,
                      'SQLITE_INTERRUPT',
                    ),
                  ),
                ),
              options.timeoutMs,
            )
          : undefined
        const abort = () => stop(new DbAdminError('The query was canceled.', 409, 'canceled'))
        options.signal?.addEventListener('abort', abort, { once: true })
        const done = () => {
          answered = true
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
        worker.post({ ...message, id })
      })
    }
    const attempt = async () => {
      try {
        return await run()
      } catch (error) {
        if (!(error instanceof NoProcess)) throw error
        this.#kind = 'thread'
        return await run()
      } finally {
        this.#rest()
      }
    }
    return options.now ? attempt() : this.after(attempt)
  }

  /** Done once a worker stopped at its limit, or canceled, has really gone. */
  gone(): Promise<void> {
    return this.#going
  }

  /** A process with nothing to run is let go of after a while: it's a whole Node, kept for one file. */
  #rest(): void {
    if (this.#kind !== 'process') return
    clearTimeout(this.#idle)
    this.#idle = setTimeout(() => {
      if (this.#pending.size === 0) this.stop()
    }, PROCESS_IDLE_MS)
    this.#idle.unref()
  }

  /** Stops the worker once the requests before this are done: what it held on the file goes. */
  async close(): Promise<void> {
    await this.#queue
    clearTimeout(this.#idle)
    const worker = this.#worker
    this.#worker = null
    await worker?.stop()
  }

  /** Stops the worker now, whatever it's doing: the requests it had fail. */
  stop(): void {
    clearTimeout(this.#idle)
    const worker = this.#worker
    this.#worker = null
    if (worker) this.#going = worker.stop().catch(() => {})
  }
}

/** Whether a statement was stopped while it ran: at its time limit, or canceled. */
function stoppedPartWay(error: unknown): boolean {
  return (
    (error instanceof QueryError && error.sqlState === 'SQLITE_INTERRUPT') ||
    (error instanceof DbAdminError && error.code === 'canceled')
  )
}

class SqliteDriver implements Driver {
  readonly kind = 'sqlite'
  readonly capabilities: Capabilities = { schemas: false, transactionalDdl: true, cancel: true }
  readonly sql = { identifier: doubleQuote, literal: sqliteLiteral, bytes: sqliteBytes }
  readonly #path: string
  readonly #exportIdleMs: number
  /** The driver's own statements, one at a time. */
  readonly #lane: Lane
  /** Someone's own SQL: in a process, which a time limit can really stop. */
  readonly #own: Lane
  /** Their writes under way, and whether the driver was closed: no statement starts after that. */
  #writing = 0
  #closed = false

  constructor(path: string, options: SqliteOptions) {
    this.#path = path
    this.#exportIdleMs = options.exportIdleMs ?? EXPORT_IDLE_MS
    this.#lane = new Lane(path)
    this.#own = new Lane(path, 'process')
  }

  #send<T>(
    message: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    // Closed is closed for every way in: a request after it would start a worker nobody stops.
    if (this.#closed) {
      return Promise.reject(new ConnectionError('The SQLite connection was closed.'))
    }
    return this.#lane.send<T>(message, options)
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
      /** Someone's own SQL, not the driver's: it runs on a handle of its own, closed after. */
      own?: boolean
    },
  ) {
    const message = {
      type: 'run',
      sql,
      params,
      maxRows: options.maxRows,
      write: options.write,
      transaction: options.transaction ?? false,
      own: options.own ?? false,
    }
    type Ran = {
      columns: { name: string; type: string }[]
      rows: (string | null)[][]
      truncated: boolean
      changes: number | null
    }
    // In its turn among the driver's statements, as when one worker ran both: two writers on
    // the file at once would have one of them find it locked.
    if (options.own) {
      return this.#lane.after(async () => {
        if (this.#closed) throw new ConnectionError('The SQLite connection was closed.')
        if (options.write) this.#writing += 1
        try {
          return await this.#own.send<Ran>(message, options)
        } catch (error) {
          // A write stopped part-way may have left its journal: undone here, by the driver's
          // own handle, before the grid's next read finds it and can't.
          if (options.write && stoppedPartWay(error)) {
            await this.#own.gone()
            await this.#lane
              .send({ type: 'recover' }, { timeoutMs: 30_000, now: true })
              .catch((failed: unknown) =>
                console.error(
                  'otw-db: could not recover the SQLite file after a stopped write',
                  failed,
                ),
              )
          }
          throw error
        } finally {
          if (options.write) this.#writing -= 1
        }
      })
    }
    return this.#send<Ran>(message, options)
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

  /**
   * What a statement must know of the table's columns that their values don't say: which hold
   * bytes, and which SQLite computes itself. A column holds bytes when it's declared BLOB, or
   * with no type at all: SQLite lets any column hold a blob, but those are where they're kept.
   */
  async #columns(schema: string, table: string): Promise<Map<string, ExportColumn>> {
    // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden (2 virtual, 3 stored).
    const rows = await this.#catalog(
      `PRAGMA ${doubleQuote(schema)}.table_xinfo(${doubleQuote(table)})`,
    )
    return new Map(
      rows.map(([, name, type, , , , hidden]) => [
        name!,
        {
          name: name!,
          ...(!type || /blob/i.test(type) ? { bytes: true } : {}),
          ...(hidden === '2' || hidden === '3' ? { generated: true } : {}),
        },
      ]),
    )
  }

  /** The table's columns that hold bytes; not looked up where nothing is compared with a column. */
  async #bytes(schema: string, table: string, needed = true): Promise<ReadonlySet<string>> {
    if (!needed) return new Set()
    const columns = await this.#columns(schema, table)
    return new Set([...columns.values()].filter((c) => c.bytes).map((c) => c.name))
  }

  async rows(
    { schema, table, limit, offset, order = [], filters = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const parameters = new Parameters(dialect, await this.#bytes(schema, table, filters.length > 0))
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
    const parameters = new Parameters(dialect, await this.#bytes(schema, table, filters.length > 0))
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
   * One statement, on a handle of its own that's closed after it: read access opens the file
   * read-only, write access runs in a transaction, or alone where SQLite refuses one (VACUUM).
   * Nothing a statement sets up outlasts it.
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const started = performance.now()
    const write = options.access === 'write'
    const command = sqliteFirstWord(sql)
    this.#refuseOtherFiles(command, sql)
    const pragma = processWidePragma(sql)
    if (pragma) {
      throw new DbAdminError(
        `PRAGMA ${pragma} reaches past this database: it sets something for every SQLite database this server has open, or names another file. It isn’t set from here.`,
        403,
        'not-allowed',
      )
    }
    const run = (transaction: boolean) =>
      this.#run(sql, [], { ...options, write, transaction, own: true })
    let result
    try {
      try {
        result = await run(write)
      } catch (error) {
        if (!write || !/within a transaction/i.test((error as Error).message)) throw error
        result = await run(false)
      }
    } catch (error) {
      if (!(error instanceof LeftOpen)) throw error
      throw new DbAdminError(
        `A transaction can’t stay open here: each statement is committed as it finishes, and ${command} would leave one open.`,
        400,
        'no-transactions',
      )
    }
    return {
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      command,
      affectedRows: result.changes ?? (result.truncated ? null : result.rows.length),
      durationMs: Math.round(performance.now() - started),
    }
  }

  /**
   * SQLite has no roles: a connection's one boundary is the file it opens. ATTACH opens any other
   * file the process can read, and VACUUM INTO writes one anywhere it can write, even from a
   * read-only handle. Both are statements of their own, never part of another, so their first
   * word tells.
   */
  #refuseOtherFiles(command: string, sql: string): void {
    const file = basename(this.#path)
    if (command === 'ATTACH') {
      throw new DbAdminError(
        `This connection opens ${file} only: ATTACH would open another file on the server.`,
        403,
        'not-allowed',
      )
    }
    if (command === 'DETACH') {
      throw new DbAdminError(
        `This connection opens ${file} only: DETACH has nothing to let go of.`,
        403,
        'not-allowed',
      )
    }
    if (command === 'VACUUM' && /\binto\b/i.test(sql)) {
      throw new DbAdminError(
        'VACUUM INTO writes a copy of the database to a file on the server, which this tool doesn’t do. Export the tables instead.',
        403,
        'not-allowed',
      )
    }
  }

  async apply(
    { schema, table }: { schema: string; table: string },
    changes: readonly Change[],
    { timeoutMs, dryRun = false }: { timeoutMs: number; dryRun?: boolean },
  ): Promise<ApplyResult> {
    const target = `${doubleQuote(schema)}.${doubleQuote(table)}`
    const bytes = await this.#bytes(schema, table)
    const statements = changes.map((change) => changeStatement(dialect, target, change, bytes))
    const shown = statements.map((s) => s.shown)
    if (dryRun) return { statements: shown, applied: false }
    try {
      await this.#send(
        {
          type: 'apply',
          statements: statements.map((s) => ({
            sql: s.text,
            params: s.values,
            oneRow: s.oneRow,
            shown: s.shown,
            ...(s.check
              ? { check: { sql: s.check.text, params: s.check.values, original: s.check.original } }
              : {}),
          })),
        },
        { timeoutMs },
      )
    } catch (error) {
      // The worker rolled back; which cell, and from what to what, is said here as for the others.
      if (error instanceof Changed) refuseChanged(dialect, statements[error.index]!, error.current)
      throw error
    }
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
  ): AsyncGenerator<{ columns: ExportColumn[]; rows: (string | null)[][] }> {
    const known = await this.#columns(schema, table)
    const bytes = new Set([...known.values()].filter((c) => c.bytes).map((c) => c.name))
    const parameters = new Parameters(dialect, bytes)
    const sql = `SELECT * FROM ${doubleQuote(schema)}.${doubleQuote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    // A worker of its own: a statement of someone else's stopped at its time limit takes the
    // driver's worker with it, and would take every export being read from that worker too.
    const lane = new Lane(this.#path)
    // Mid-read, the export holds the file (in a rollback journal, no write of the host's can
    // commit meanwhile): nobody reading, it would hold it for as long as the browser stays away.
    let stalled = false
    const stall = () => {
      stalled = true
      lane.stop()
    }
    try {
      const opened = await lane.send<{ cursor: number; columns: { name: string }[] }>(
        { type: 'open', sql, params: parameters.values },
        { timeoutMs },
      )
      const cursor = opened.cursor
      const columns = opened.columns.map((c) => known.get(c.name) ?? { name: c.name })
      for (let first = true, done = false; !done; first = false) {
        const batch = await lane.send<{ rows: (string | null)[][]; done: boolean }>(
          { type: 'next', cursor, count: EXPORT_BATCH },
          { timeoutMs },
        )
        done = batch.done
        if (batch.rows.length || first) {
          const waiting = setTimeout(stall, this.#exportIdleMs)
          waiting.unref()
          try {
            yield { columns, rows: batch.rows }
          } finally {
            clearTimeout(waiting)
          }
          if (stalled) throw stalledExport(this.#exportIdleMs)
        }
      }
    } finally {
      // The worker goes, and with it the cursor and its hold on the file, read to the end or not.
      await lane.close()
    }
  }

  async close(): Promise<void> {
    // Someone's statement still running is stopped, not waited for, and those behind it don't
    // start: none has an end it must reach. A write stopped part-way is undone before the file
    // is let go of, as at a time limit.
    this.#closed = true
    const writing = this.#writing > 0
    this.#own.stop()
    if (writing) {
      await this.#own.gone()
      await this.#lane.send({ type: 'recover' }, { timeoutMs: 30_000 }).catch(() => {})
    }
    await this.#lane.close()
    await this.#own.close()
  }
}

/** A statement that left a transaction open on its handle: BEGIN or SAVEPOINT, run alone. */
class LeftOpen extends Error {}

/** An update's check found its cells changed, or its row gone (`current` undefined). */
class Changed extends Error {
  constructor(
    readonly index: number,
    readonly current: (string | null)[] | undefined,
  ) {
    super('A cell was changed meanwhile.')
  }
}

/** The worker's errors as the API's. */
function fromWorker(error: WorkerError): Error {
  if (error.leftOpen) return new LeftOpen(error.message)
  if (error.changed) return new Changed(error.changed.index, error.changed.current ?? undefined)
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
