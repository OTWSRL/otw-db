import type CursorClass from 'pg-cursor'
import { connect } from 'node:net'
import type { FieldDef, Pool, PoolClient, PoolConfig, QueryArrayConfig } from 'pg'
import { ConnectionError, DbAdminError, QueryError } from '../errors.ts'
import { refuseBeyondReadingPostgres } from './read-only.ts'
import {
  DATABASES_SQL,
  detail,
  dialect,
  EXPORT_COLUMNS_SQL,
  exportColumns,
  INFO_SQL,
  quote,
  sqlDialect,
  summary,
  TABLE_SQL,
  TABLES_SQL,
  TYPE_NAMES_SQL,
  versionOf,
  type CatalogDetail,
  type CatalogTable,
} from './postgres-catalog.ts'
import {
  changeStatement,
  EXPORT_IDLE_MS,
  orderBy,
  Parameters,
  refuseChanged,
  seconds,
  stalledExport,
  where,
  whole,
} from './sql.ts'
import type {
  ApplyResult,
  Capabilities,
  Change,
  DatabaseList,
  Driver,
  ExportColumn,
  QueryOptions,
  QueryResult,
  ResultSet,
  RowsRequest,
  ServerInfo,
  Session,
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

/**
 * Imports pg and pg-cursor, as `() => Promise.all([import('pg'), import('pg-cursor')])` does.
 * Each may be its import's namespace or the package's own export.
 */
export type PostgresModules = () => Promise<readonly [pg: unknown, pgCursor: unknown]>

/** How a PostgreSQL driver gets the packages it runs on. */
export interface PostgresOptions {
  /**
   * Where pg and pg-cursor come from. By default they're imported where the app runs, from the
   * app's own dependencies. A package that brings them as its own dependencies and is bundled into
   * the app, such as the OTW CMS plugin, passes its own imports: the app's bundler resolves those
   * from that package, which pnpm requires, since it keeps a package's dependencies beside it.
   */
  modules?: PostgresModules
  /**
   * How long a request waits for one of the pool's three connections, or for the server to
   * answer, before it fails and says so. Defaults to 10 seconds.
   */
  connectTimeoutMs?: number
  /**
   * How long an export may sit between two batches, its rows unread, before it's ended and its
   * connection is free again. Defaults to 5 minutes.
   */
  exportIdleMs?: number
}

const CONNECT_TIMEOUT_MS = 10_000
const POOL_SIZE = 3

// Imported where the app runs, not bundled: an app installs only the drivers it uses, and a
// bundler (Next.js) mustn't fail on one it doesn't have.
const fromApp: PostgresModules = () =>
  Promise.all([
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'pg'),
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'pg-cursor'),
  ])

let appModules: Promise<Modules> | undefined

/** pg and pg-cursor, imported on the first PostgreSQL connection, so other hosts never load them. */
function loadModules(given: PostgresModules | undefined): Promise<Modules> {
  if (given) return load(given, 'Could not load pg and pg-cursor')
  appModules ??= load(
    fromApp,
    'PostgreSQL connections need the pg and pg-cursor packages, installed in the app: npm install pg pg-cursor',
  ).catch((error: unknown) => {
    appModules = undefined
    throw error
  })
  return appModules
}

async function load(modules: PostgresModules, failure: string): Promise<Modules> {
  let pg: unknown, cursor: unknown
  try {
    ;[pg, cursor] = await modules()
  } catch (error) {
    throw new DbAdminError(`${failure}: ${(error as Error).message}`, 500, 'driver-missing')
  }
  // A CommonJS package's import has its export as the default, and pg's ESM entry names Pool too.
  const exports = pg as { Pool?: typeof Pool; default?: { Pool?: typeof Pool } }
  const PoolClass = exports.Pool ?? exports.default?.Pool
  const Cursor = (cursor as { default?: unknown } | undefined)?.default ?? cursor
  if (typeof PoolClass !== 'function' || typeof Cursor !== 'function') {
    throw new DbAdminError(`${failure}: they aren't pg's and pg-cursor's`, 500, 'driver-missing')
  }
  return { Pool: PoolClass, Cursor: Cursor as typeof CursorClass }
}

/** A placeholder host for a URL with none, as pg's own parser uses: `user@/db?host=/socket`. */
const NO_HOST = '___otw_db_no_host___'

/**
 * `url` at another of its server's databases: its path swapped for `database`, its login, host and
 * settings kept. pg reads the path back with decodeURI, which leaves `?` and `#` escaped, so a
 * name with either can't be carried.
 */
export function postgresUrlAt(url: string, database: string): string {
  if (/[?#]/.test(database)) {
    throw new DbAdminError(
      `The database "${database}" can't be opened: a connection URL can't name a database with ? or #.`,
      400,
      'bad-database',
    )
  }
  const hostless = url.includes('@/')
  let parsed: URL
  try {
    parsed = new URL(hostless ? url.replace('@/', `@${NO_HOST}/`) : url)
  } catch {
    // Not the URL itself, which may hold a password.
    throw new DbAdminError(
      "The connection's URL can't be moved to another database.",
      500,
      'bad-url',
    )
  }
  parsed.pathname = `/${encodeURI(database)}`
  return hostless ? parsed.href.replace(`@${NO_HOST}/`, '@/') : parsed.href
}

/**
 * A PostgreSQL driver for `url`. It connects on first use, with a pool of up to three
 * connections, each closed after 10 s unused; an admin tool needs few.
 */
export function postgresDriver(url: string, options: PostgresOptions = {}): Driver {
  return new PostgresDriver(url, options)
}

class PostgresDriver implements Driver {
  readonly kind = 'postgres'
  readonly capabilities: Capabilities = { schemas: true, transactionalDdl: true, cancel: true }
  readonly sql = sqlDialect
  readonly pgUrl: string
  readonly #url: string
  readonly #config: PoolConfig
  readonly #modules: PostgresModules | undefined
  readonly #options: PostgresOptions
  readonly #connectTimeoutMs: number
  readonly #exportIdleMs: number
  #pool: Promise<{ pool: Pool; modules: Modules }> | undefined
  /** Type names by OID, filled as results bring new ones. */
  readonly #typeNames = new Map<number, string>()
  /** Closed for good: a pool opened after that would be one nobody closes. */
  #closed = false
  /** The pool's clients that have their error listener: each comes back many times. */
  readonly #heard = new WeakSet<PoolClient>()

  constructor(url: string, options: PostgresOptions) {
    this.#url = url
    this.pgUrl = url
    this.#options = options
    this.#modules = options.modules
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.#exportIdleMs = options.exportIdleMs ?? EXPORT_IDLE_MS
    this.#config = {
      connectionString: url,
      max: POOL_SIZE,
      idleTimeoutMillis: 10_000,
      // Without it a request waits for good behind three connections that are held: exports
      // nobody reads, a backup under way.
      connectionTimeoutMillis: this.#connectTimeoutMs,
      application_name: 'otw-db',
      types: AS_TEXT,
    }
  }

  #open(): Promise<{ pool: Pool; modules: Modules }> {
    // Whoever still holds a driver that was closed (a request under way when its database was
    // the one used longest ago) is told, and asks again for one that's open.
    if (this.#closed) {
      return Promise.reject(
        new ConnectionError('This connection to PostgreSQL was closed. Try again.'),
      )
    }
    this.#pool ??= loadModules(this.#modules).then(
      (modules) => {
        const pool = new modules.Pool(this.#config)
        // An idle connection the server drops would otherwise take the whole process with it.
        pool.on('error', (error) => console.error('otw-db: a PostgreSQL connection failed', error))
        return { pool, modules }
      },
      (error: unknown) => {
        // Nothing opened: the next call tries again.
        this.#pool = undefined
        throw error
      },
    )
    return this.#pool
  }

  async #connect(): Promise<{ client: PoolClient; modules: Modules }> {
    const { pool, modules } = await this.#open()
    let client: PoolClient
    try {
      client = await pool.connect()
    } catch (error) {
      const message = (error as Error).message
      // pg-pool's one message for both: no connection came free, or none could be opened in time.
      throw new ConnectionError(
        /timeout exceeded when trying to connect/i.test(message)
          ? `All ${POOL_SIZE} of this connection’s PostgreSQL connections are busy (an export or a backup under way, perhaps), or the server didn’t answer in ${seconds(this.#connectTimeoutMs)}. Try again in a moment.`
          : `Could not connect to PostgreSQL: ${message}`,
      )
    }
    if (!this.#heard.has(client)) {
      this.#heard.add(client)
      // The pool listens for a client's errors only while the client is idle in it. The server
      // dropping one that's held (between an export's batches, in a backup's session) emits an
      // error too, and one nobody listens for ends the process. The statement that next finds
      // the connection gone reports it.
      client.on('error', () => {})
    }
    return { client, modules }
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

  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    // Someone's own statement, not one the driver wrote for the grid, whose table may well be
    // named like something refused here. Before a connection is taken: nothing to give back.
    if (options.access === 'read') refuseBeyondReadingPostgres(sql)
    return this.#run(sql, undefined, options)
  }

  async databases(): Promise<DatabaseList> {
    const rows = await this.#catalog<{ name: string; current: string }>(DATABASES_SQL)
    return {
      current: rows.find((row) => row.current === 't')?.name ?? '',
      databases: rows.map((row) => row.name),
    }
  }

  withDatabase(name: string): Driver {
    return new PostgresDriver(postgresUrlAt(this.#url, name), this.#options)
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
        if (statement.check) {
          // As the grid read them: every value the server's own text.
          const { rows } = await client.query({
            text: statement.check.text,
            values: statement.check.values,
            rowMode: 'array',
            types: AS_TEXT,
          })
          refuseChanged(dialect, statement, rows[0] as (string | null)[] | undefined)
        }
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
  ): AsyncGenerator<{ columns: ExportColumn[]; rows: (string | null)[][] }> {
    const parameters = new Parameters(dialect)
    const values = parameters.values
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    const { client, modules } = await this.#connect()
    // Until the last batch is read, the connection is mid-transaction: a stop on the way closes it.
    let finished = false
    let released = false
    const release = (destroy: boolean) => {
      if (released) return
      released = true
      client.release(destroy)
    }
    // An export nobody reads sits between two batches with its cursor open: it would hold one of
    // the pool's three connections, a snapshot and a lock on the table for as long as the browser
    // stays away. No server timeout covers that wait (the session counts as active, and
    // statement_timeout isn't acted on while it waits for the client), so it's ended from here.
    let stalled = false
    const stall = () => {
      stalled = true
      release(true)
    }
    try {
      await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
      const catalog = await client.query({
        text: EXPORT_COLUMNS_SQL,
        values: [schema, table],
        rowMode: 'array',
        types: AS_TEXT,
      })
      const cursor = client.query(
        new modules.Cursor(sql, values, { rowMode: 'array', types: AS_TEXT } as never),
      )
      // The first batch always, even empty, so a file of no rows still has its column names.
      for (let first = true; ; first = false) {
        const { rows, fields } = await readBatch(cursor, EXPORT_BATCH)
        if (rows.length || first) {
          const names = fields.map((f) => f.name)
          const waiting = setTimeout(stall, this.#exportIdleMs)
          // The wait is its reader's, not the process's: it doesn't keep a server from stopping.
          waiting.unref()
          try {
            yield { columns: exportColumns(names, catalog.rows as (string | null)[][]), rows }
          } finally {
            clearTimeout(waiting)
          }
          if (stalled) break
        }
        if (rows.length < EXPORT_BATCH) break
      }
      if (stalled) throw stalledExport(this.#exportIdleMs)
      await new Promise<void>((resolve, reject) => cursor.close((e) => (e ? reject(e) : resolve())))
      await client.query(READ_CLEANUP)
      finished = true
    } catch (error) {
      throw toError(error)
    } finally {
      release(!finished)
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
    const read = options.access === 'read'
    // A write may leave anything on its connection (SET, SET ROLE, temporary tables, session
    // locks), so the connection is closed after it rather than handed to the next query.
    let discard = !read
    // Whether the connection is known to be outside a transaction: only then does it go back
    // to the pool. An error in the driver's own BEGIN, COMMIT or cleanup leaves that unknown.
    let outside = true
    // A cancel names a connection, not a statement: one still on its way when the statement
    // ends would stop whatever runs there next, the driver's own cleanup or someone else's
    // query. So the request is waited for before the connection is used again: once the server
    // has it, it stops the statement or, the statement over, is dropped. One that can't be
    // waited for (a second at most) costs the connection instead.
    let canceling: Promise<void> | undefined
    const cancel = () => {
      canceling = sendCancel(client)
    }
    const canceled = async () => {
      if (!canceling) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          discard = true
          resolve()
        }, 1_000)
      })
      await Promise.race([canceling, late])
      clearTimeout(timer)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    let result: CursorResult
    let durationMs: number
    try {
      if (options.signal?.aborted)
        throw new DbAdminError('The query was canceled.', 409, 'canceled')
      outside = false
      await client.query(
        `BEGIN${read ? ' READ ONLY' : ''}; SET LOCAL statement_timeout = ${whole(options.timeoutMs)}`,
      )
      let alone = false
      // Once the statement is over there is nothing left to cancel: a cancel sent from here on
      // would only find the driver's cleanup, or whoever has the connection next.
      const over = () => options.signal?.removeEventListener('abort', cancel)
      try {
        result = await readCursor(modules, client, sql, values, options.maxRows)
        over()
      } catch (error) {
        over()
        let rolledBack = true
        await canceled()
        // The statement's own error is the one to report, whatever the cleanup does.
        await client.query(read ? READ_CLEANUP : 'ROLLBACK').catch(() => {
          rolledBack = false
          discard = true
        })
        outside = rolledBack
        if (read || !rolledBack || sqlState(error) !== NOT_IN_TRANSACTION) throw error
        // VACUUM and the like: alone, on a connection closed afterwards like every write's, so
        // a cancel may be sent again, and find nobody after it.
        await client.query(`SET statement_timeout = ${whole(options.timeoutMs)}`)
        // Canceled meanwhile: a listener put back on a signal that has fired never hears it.
        if (options.signal?.aborted)
          throw new DbAdminError('The query was canceled.', 409, 'canceled')
        options.signal?.addEventListener('abort', cancel, { once: true })
        result = await readCursor(modules, client, sql, values, options.maxRows)
        over()
        alone = true
      }
      await canceled()
      if (!alone) await client.query(read ? READ_CLEANUP : 'COMMIT')
      outside = true
      durationMs = Math.round(performance.now() - started)
    } catch (error) {
      if (!(error instanceof DbAdminError) && !(error as { severity?: string }).severity) {
        discard = true
      }
      throw toError(error, options.signal)
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      client.release(discard || !outside)
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

  /** A transaction on a connection of its own, closed after: a restore's SETs leave with it. */
  async session(mode: 'snapshot' | 'write'): Promise<Session> {
    const { client } = await this.#connect()
    try {
      if (mode === 'write') await oneStatementOnly(client)
      await client.query(
        mode === 'snapshot' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      )
    } catch (error) {
      client.release(true)
      throw toError(error)
    }
    let ended = false
    // What the server says after every query: I outside a transaction, T inside one, E inside
    // one that failed. It costs nothing to hear, where asking would be a round trip a statement.
    let status: string | undefined = 'T'
    const connection = (client as unknown as { connection?: Heard }).connection
    const heard = (message: { status?: string }) => {
      status = message.status
    }
    connection?.on('readyForQuery', heard)
    return {
      exclusive: false,
      inTransaction: () => status !== 'I',
      async query(text, values) {
        try {
          const result = await client.query({
            ...extended(text),
            ...(values
              ? {
                  values: values.map((v) =>
                    v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v,
                  ),
                }
              : {}),
          })
          return { rows: result.rows as (string | null)[][] }
        } catch (error) {
          throw toError(error)
        }
      },
      async end(commit) {
        if (ended) return
        ended = true
        try {
          await client.query(commit ? 'COMMIT' : 'ROLLBACK')
        } catch (error) {
          throw toError(error)
        } finally {
          connection?.off('readyForQuery', heard)
          client.release(true)
        }
      },
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    const opened = this.#pool
    this.#pool = undefined
    // One that failed to open has nothing to close.
    const pool = await opened?.catch(() => undefined)
    await pool?.pool.end()
  }
}

/**
 * A session's query, over the extended protocol: one statement a query, whatever the text holds,
 * as the server refuses a second. A restore's statements come from a file, and none may carry
 * another that ends its transaction. (pg's types don't list queryMode yet.)
 */
function extended(text: string): QueryArrayConfig<unknown[]> & { queryMode: 'extended' } {
  return { text, rowMode: 'array', types: AS_TEXT, queryMode: 'extended' }
}

/**
 * Makes sure of it, on the connection a write session is about to use, before its transaction
 * begins: two statements in one query must be refused. pg takes queryMode from 8.12 on; an
 * older one ignores it and sends text without values over the simple protocol, which runs every
 * statement in it, and nothing asked of it afterwards could undo the second. So a restore never
 * starts on a connection that would have run both: it says to update pg instead. Reading, and
 * so a backup, is the same on any pg.
 */
async function oneStatementOnly(client: PoolClient): Promise<void> {
  try {
    await client.query(extended('SELECT 1; SELECT 2'))
  } catch (error) {
    // 42601: "cannot insert multiple commands into a prepared statement".
    if ((error as { code?: string }).code === '42601') return
    throw error
  }
  throw new DbAdminError(
    'This server’s PostgreSQL driver (pg) runs several statements sent as one, so a restore can’t be held to one transaction. Update pg to 8.12 or later.',
    500,
    'driver-unsafe',
  )
}

/** pg's connection, as far as a session listens to it: the server's ReadyForQuery after a query. */
interface Heard {
  on(event: 'readyForQuery', listener: (message: { status?: string }) => void): void
  off(event: 'readyForQuery', listener: (message: { status?: string }) => void): void
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
/** Sends the cancel request. Done once the server has taken it and closed, or it couldn't be sent. */
function sendCancel(client: PoolClient): Promise<void> {
  const { host, port, processID, secretKey } = client as PoolClient & Backend
  if (processID === null || secretKey === null) return Promise.resolve()
  const message = Buffer.alloc(16)
  message.writeInt32BE(16, 0)
  message.writeInt32BE(80877102, 4)
  message.writeInt32BE(processID, 8)
  message.writeInt32BE(secretKey, 12)
  return new Promise<void>((resolve) => {
    const socket = host.startsWith('/')
      ? connect(`${host}/.s.PGSQL.${port}`)
      : connect({ host, port })
    socket.setTimeout(5_000, () => socket.destroy())
    socket.once('connect', () => socket.end(message))
    socket.once('error', (error) =>
      console.error('otw-db: could not send the cancel request', error),
    )
    // The server closes its end once the request is in the statement's hands.
    socket.once('close', () => resolve())
    socket.resume()
  })
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
