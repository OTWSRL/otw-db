import type CursorClass from 'pg-cursor'
import { connect } from 'node:net'
import type { FieldDef, Pool, PoolClient, PoolConfig } from 'pg'
import { ConnectionError, DbAdminError, QueryError } from '../errors.ts'
import {
  detail,
  dialect,
  INFO_SQL,
  literal,
  quote,
  summary,
  TABLE_SQL,
  TABLES_SQL,
  TYPE_NAMES_SQL,
  versionOf,
  type CatalogDetail,
  type CatalogTable,
} from './postgres-catalog.ts'
import { changeStatement, orderBy, Parameters, where, whole } from './sql.ts'
import type {
  ApplyResult,
  Capabilities,
  Change,
  Driver,
  QueryOptions,
  QueryResult,
  ResultSet,
  RowsRequest,
  ServerInfo,
  TableDetail,
  TableSummary,
} from '../types.ts'

/** Every value as the server's text: nothing converted, so nothing lost. */
const AS_TEXT = { getTypeParser: () => (value: string) => value }

/**
 * Ends a read: ROLLBACK undoes its settings (SET, SET ROLE) and anything it declared; session
 * advisory locks outlast a rollback, so they go too.
 */
const READ_CLEANUP = 'ROLLBACK; SELECT pg_advisory_unlock_all()'

/** PostgreSQL's "cannot run inside a transaction block", as VACUUM and CREATE INDEX CONCURRENTLY say. */
const NOT_IN_TRANSACTION = '25001'
/** "canceling statement due to user request", after a cancel. */
const CANCELED = '57014'

interface Modules {
  Pool: typeof Pool
  Cursor: typeof CursorClass
}

let modules: Promise<Modules> | undefined

/** pg and pg-cursor, imported on the first PostgreSQL connection, so other hosts never load them. */
function loadModules(): Promise<Modules> {
  // Imported where the host runs, not bundled: a site installs only the drivers it uses, and a
  // bundler (Next.js) mustn't fail on one it doesn't have.
  modules ??= Promise.all([
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'pg'),
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'pg-cursor'),
  ]).then(
    ([pg, cursor]) => ({ Pool: pg.Pool, Cursor: cursor.default }),
    (error: unknown) => {
      modules = undefined
      throw new DbAdminError(
        `PostgreSQL connections need the pg and pg-cursor packages: npm install pg pg-cursor (${(error as Error).message})`,
        500,
        'driver-missing',
      )
    },
  )
  return modules
}

/**
 * A PostgreSQL driver for `url`. It connects on first use, with a pool of up to three
 * connections, each closed after 10 s unused; an admin tool needs few.
 */
export function postgresDriver(url: string): Driver {
  return new PostgresDriver(url)
}

class PostgresDriver implements Driver {
  readonly kind = 'postgres'
  readonly capabilities: Capabilities = { schemas: true, transactionalDdl: true, cancel: true }
  readonly sql = { identifier: quote, literal }
  readonly #config: PoolConfig
  #pool: Promise<{ pool: Pool; modules: Modules }> | undefined
  /** Type names by OID, filled as results bring new ones. */
  readonly #typeNames = new Map<number, string>()

  constructor(url: string) {
    this.#config = {
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      application_name: 'otw-db',
      types: AS_TEXT,
    }
  }

  #open(): Promise<{ pool: Pool; modules: Modules }> {
    this.#pool ??= loadModules().then((modules) => {
      const pool = new modules.Pool(this.#config)
      // An idle connection the server drops would otherwise take the whole process with it.
      pool.on('error', (error) => console.error('otw-db: a PostgreSQL connection failed', error))
      return { pool, modules }
    })
    return this.#pool
  }

  async #connect(): Promise<{ client: PoolClient; modules: Modules }> {
    const { pool, modules } = await this.#open()
    try {
      return { client: await pool.connect(), modules }
    } catch (error) {
      throw new ConnectionError(`Could not connect to PostgreSQL: ${(error as Error).message}`)
    }
  }

  async #catalog<T>(text: string, values: unknown[] = []): Promise<T[]> {
    const { client } = await this.#connect()
    try {
      return (await client.query(text, values)).rows as T[]
    } catch (error) {
      throw toError(error)
    } finally {
      client.release()
    }
  }

  async tables(): Promise<TableSummary[]> {
    const rows = await this.#catalog<CatalogTable>(TABLES_SQL)
    return rows.map(summary)
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const [row] = await this.#catalog<CatalogTable & CatalogDetail>(TABLE_SQL, [schema, name])
    return row ? detail(row) : null
  }

  async rows(
    { schema, table, limit, offset, order = [], filters = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const parameters = new Parameters(dialect)
    const filtered = `${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}`
    // One row past the page tells whether there's another.
    const sql = `SELECT * FROM ${filtered}${orderBy(dialect, order)} LIMIT ${whole(limit) + 1} OFFSET ${whole(offset)}`
    const { columns, rows, truncated, durationMs } = await this.#run(sql, parameters.values, {
      ...options,
      access: 'read',
      maxRows: limit,
    })
    return { columns, rows, truncated, durationMs }
  }

  async count(
    { schema, table, filters = [] }: Pick<RowsRequest, 'schema' | 'table' | 'filters'>,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<number> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT count(*) FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}`
    const { rows } = await this.#run(sql, parameters.values, {
      ...options,
      access: 'read',
      maxRows: 1,
    })
    return Number(rows[0]![0])
  }

  async info(): Promise<ServerInfo> {
    const [row] = await this.#catalog<Omit<ServerInfo, 'product'>>(INFO_SQL)
    return { product: 'PostgreSQL', ...row!, version: versionOf(row!.version) }
  }

  query(sql: string, options: QueryOptions): Promise<QueryResult> {
    return this.#run(sql, undefined, options)
  }

  async apply(
    { schema, table }: { schema: string; table: string },
    changes: readonly Change[],
    { timeoutMs, dryRun = false }: { timeoutMs: number; dryRun?: boolean },
  ): Promise<ApplyResult> {
    const statements = changes.map((change) =>
      changeStatement(dialect, `${quote(schema)}.${quote(table)}`, change),
    )
    const shown = statements.map((s) => s.shown)
    if (dryRun) return { statements: shown, applied: false }
    const { client } = await this.#connect()
    try {
      await client.query(`BEGIN; SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
      for (const statement of statements) {
        const { rowCount } = await client.query(statement.text, statement.values)
        if (statement.oneRow && rowCount !== 1) {
          const why =
            rowCount === 0
              ? 'its row is gone or its key changed'
              : `its key matched ${rowCount} rows`
          throw new DbAdminError(`Nothing was saved: ${why}.\n${statement.shown}`, 409, 'conflict')
        }
      }
      await client.query('COMMIT')
      return { statements: shown, applied: true }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw toError(error)
    } finally {
      // A write, closed after like every other.
      client.release(true)
    }
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
    const values = parameters.values
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    const { client, modules } = await this.#connect()
    // Until the last batch is read, the connection is mid-transaction: a stop on the way closes it.
    let finished = false
    try {
      await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
      const cursor = client.query(
        new modules.Cursor(sql, values, { rowMode: 'array', types: AS_TEXT } as never),
      )
      // The first batch always, even empty, so a file of no rows still has its column names.
      for (let first = true; ; first = false) {
        const { rows, fields } = await readBatch(cursor, EXPORT_BATCH)
        if (rows.length || first) yield { columns: fields.map((f) => ({ name: f.name })), rows }
        if (rows.length < EXPORT_BATCH) break
      }
      await new Promise<void>((resolve, reject) => cursor.close((e) => (e ? reject(e) : resolve())))
      await client.query(READ_CLEANUP)
      finished = true
    } catch (error) {
      throw toError(error)
    } finally {
      client.release(!finished)
    }
  }

  /**
   * One statement, in a transaction with its own statement timeout. Through pg-cursor, so the
   * extended protocol runs it, which takes one statement only: `COMMIT; DROP …` can't step out of
   * a read-only transaction. A statement that refuses to run in a transaction (VACUUM) runs
   * alone, with write access. `values` are the statement's parameters, `$1` onwards.
   */
  async #run(
    sql: string,
    values: unknown[] | undefined,
    options: QueryOptions,
  ): Promise<QueryResult> {
    const { client, modules } = await this.#connect()
    const started = performance.now()
    const cancel = () => sendCancel(client)
    options.signal?.addEventListener('abort', cancel, { once: true })
    const read = options.access === 'read'
    // A write may leave anything on its connection (SET, SET ROLE, temporary tables, session
    // locks), so the connection is closed after it rather than handed to the next query.
    let discard = !read
    let result: CursorResult
    let durationMs: number
    try {
      if (options.signal?.aborted)
        throw new DbAdminError('The query was canceled.', 409, 'canceled')
      await client.query(
        `BEGIN${read ? ' READ ONLY' : ''}; SET LOCAL statement_timeout = ${whole(options.timeoutMs)}`,
      )
      let alone = false
      try {
        result = await readCursor(modules, client, sql, values, options.maxRows)
      } catch (error) {
        let rolledBack = true
        // The statement's own error is the one to report, whatever the cleanup does.
        await client.query(read ? READ_CLEANUP : 'ROLLBACK').catch(() => {
          rolledBack = false
          discard = true
        })
        if (read || !rolledBack || sqlState(error) !== NOT_IN_TRANSACTION) throw error
        // VACUUM and the like: alone, on a connection closed afterwards like every write's.
        await client.query(`SET statement_timeout = ${whole(options.timeoutMs)}`)
        result = await readCursor(modules, client, sql, values, options.maxRows)
        alone = true
      }
      if (!alone) await client.query(read ? READ_CLEANUP : 'COMMIT')
      durationMs = Math.round(performance.now() - started)
    } catch (error) {
      if (!(error instanceof DbAdminError) && !(error as { severity?: string }).severity) {
        discard = true
      }
      throw toError(error, options.signal)
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      client.release(discard)
    }
    // After the release: naming types may take a connection of its own.
    return {
      columns: await this.#named(result.fields),
      rows: result.rows,
      truncated: result.truncated,
      command: result.command,
      affectedRows: result.rowCount,
      durationMs,
    }
  }

  /** Names for the result's column types, looking up only the ones not seen before. */
  async #named(fields: FieldDef[]): Promise<{ name: string; type: string }[]> {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID))].filter(
      (oid) => !this.#typeNames.has(oid),
    )
    if (unknown.length) {
      const rows = await this.#catalog<{ oid: string; name: string }>(TYPE_NAMES_SQL, [unknown])
      for (const row of rows) this.#typeNames.set(Number(row.oid), row.name)
    }
    return fields.map((f) => ({
      name: f.name,
      type: this.#typeNames.get(f.dataTypeID) ?? 'unknown',
    }))
  }

  async close(): Promise<void> {
    const opened = this.#pool
    this.#pool = undefined
    if (opened) await (await opened).pool.end()
  }
}

/** What pg keeps from the server's BackendKeyData, which a cancel request quotes. */
interface Backend {
  host: string
  port: number
  processID: number | null
  secretKey: number | null
}

/**
 * Stops the statement running on `client`'s connection with PostgreSQL's cancel request, as
 * psql's Ctrl+C: a 16-byte message on a new connection, naming the backend by the key it gave.
 * PgBouncer passes it on to the right server. Best effort: the statement timeout stops the query
 * when it can't get through (a proxy that takes TLS connections only, such as Neon's).
 */
function sendCancel(client: PoolClient): void {
  const { host, port, processID, secretKey } = client as PoolClient & Backend
  if (processID === null || secretKey === null) return
  const message = Buffer.alloc(16)
  message.writeInt32BE(16, 0)
  message.writeInt32BE(80877102, 4)
  message.writeInt32BE(processID, 8)
  message.writeInt32BE(secretKey, 12)
  const socket = host.startsWith('/')
    ? connect(`${host}/.s.PGSQL.${port}`)
    : connect({ host, port })
  socket.setTimeout(5_000, () => socket.destroy())
  socket.once('connect', () => socket.end(message))
  socket.once('error', (error) => console.error('otw-db: could not send the cancel request', error))
}

const EXPORT_BATCH = 1_000

function readBatch(
  cursor: CursorClass,
  count: number,
): Promise<{ rows: (string | null)[][]; fields: FieldDef[] }> {
  return new Promise((resolve, reject) =>
    cursor.read(count, (error, rows, result) =>
      error ? reject(error) : resolve({ rows: rows as (string | null)[][], fields: result.fields }),
    ),
  )
}

interface CursorResult {
  fields: FieldDef[]
  rows: (string | null)[][]
  truncated: boolean
  command: string
  rowCount: number | null
}

/** Runs `sql` through a cursor and reads at most `maxRows`, plus one to know if there were more. */
function readCursor(
  modules: Modules,
  client: PoolClient,
  sql: string,
  values: unknown[] | undefined,
  maxRows: number,
): Promise<CursorResult> {
  const cursor = client.query(
    new modules.Cursor(sql, values, { rowMode: 'array', types: AS_TEXT } as never),
  )
  return new Promise((resolve, reject) => {
    cursor.read(maxRows + 1, (error, rows, result) => {
      if (error) return reject(error)
      const truncated = rows.length > maxRows
      const finish = () =>
        resolve({
          fields: result.fields,
          rows: (truncated ? rows.slice(0, maxRows) : rows) as (string | null)[][],
          truncated,
          command: result.command ?? '',
          rowCount: truncated ? null : (result.rowCount ?? null),
        })
      // Closing the portal frees what the server holds for the rows left unread.
      cursor.close((closeError) => (closeError ? reject(closeError) : finish()))
    })
  })
}

function sqlState(error: unknown): string | undefined {
  return (error as { code?: unknown })?.code as string | undefined
}

/** pg's errors as the API's: the statement's own faults are the caller's, with the details. */
function toError(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof DbAdminError) return error
  const pgError = error as {
    message?: string
    code?: string
    position?: string
    detail?: string
    hint?: string
    severity?: string
  }
  if (sqlState(error) === CANCELED && signal?.aborted) {
    return new DbAdminError('The query was canceled.', 409, 'canceled')
  }
  // Errors from the server carry a severity; the rest (a dropped socket) are the connection's.
  if (pgError?.severity) {
    return new QueryError(pgError.message ?? 'The query failed.', pgError.code, {
      ...(pgError.position ? { position: Number(pgError.position) } : {}),
      ...(pgError.detail ? { detail: pgError.detail } : {}),
      ...(pgError.hint ? { hint: pgError.hint } : {}),
    })
  }
  return new ConnectionError(
    `The PostgreSQL connection failed: ${pgError?.message ?? String(error)}`,
  )
}
