import type CursorClass from 'pg-cursor'
import { connect } from 'node:net'
import type { FieldDef, Pool, PoolClient, PoolConfig } from 'pg'
import { ConnectionError, DbAdminError, QueryError } from '../errors.ts'
import type {
  Capabilities,
  Column,
  Definition,
  Driver,
  QueryOptions,
  QueryResult,
  ResultSet,
  RowsRequest,
  TableDetail,
  TableKind,
  TableSummary,
} from '../types.ts'

/** Every value as the server's text: nothing converted, so nothing lost. */
const AS_TEXT = { getTypeParser: () => (value: string) => value }

const KINDS: Record<string, TableKind> = {
  r: 'table',
  v: 'view',
  m: 'materialized-view',
  f: 'foreign-table',
  p: 'partitioned-table',
}
const RELKINDS = `('r','v','m','f','p')`

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
  modules ??= Promise.all([import('pg'), import('pg-cursor')]).then(
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
    const rows = await this.#catalog<CatalogTable>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS estimate,
              CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid) END AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ${RELKINDS} AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        ORDER BY 1, 2`,
    )
    return rows.map(summary)
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const [row] = await this.#catalog<CatalogTable & CatalogDetail>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS estimate,
              CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid) END AS bytes,
              obj_description(c.oid, 'pg_class') AS comment,
              (SELECT coalesce(json_agg(json_build_object(
                        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                        'nullable', NOT a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
                        'identity', a.attidentity, 'generated', a.attgenerated,
                        'comment', col_description(a.attrelid, a.attnum)) ORDER BY a.attnum), '[]')
                 FROM pg_attribute a
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
              (SELECT coalesce(json_agg(a.attname ORDER BY k.ord), '[]')
                 FROM pg_index i
                 CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_key,
              (SELECT coalesce(json_agg(json_build_object(
                        'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid))
                        ORDER BY ic.relname), '[]')
                 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                WHERE i.indrelid = c.oid) AS indexes,
              (SELECT coalesce(json_agg(json_build_object(
                        'name', conname, 'definition', pg_get_constraintdef(oid), 'type', contype)
                        ORDER BY conname), '[]')
                 FROM pg_constraint WHERE conrelid = c.oid AND contype IN ('f', 'c')) AS constraints
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${RELKINDS}`,
      [schema, name],
    )
    if (!row) return null
    const constraints = JSON.parse(row.constraints) as (Definition & { type: 'f' | 'c' })[]
    const pick = (type: 'f' | 'c') =>
      constraints
        .filter((c) => c.type === type)
        .map(({ name, definition }) => ({ name, definition }))
    return {
      ...summary(row),
      columns: (JSON.parse(row.columns) as CatalogColumn[]).map(column),
      primaryKey: JSON.parse(row.primary_key) as string[],
      indexes: JSON.parse(row.indexes) as Definition[],
      foreignKeys: pick('f'),
      checks: pick('c'),
      comment: row.comment,
    }
  }

  async rows(
    { schema, table, limit, offset, order = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const orderBy = order.length
      ? ` ORDER BY ${order.map((o) => `${quote(o.column)}${o.descending ? ' DESC' : ''}`).join(', ')}`
      : ''
    // One row past the page tells whether there's another.
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${orderBy} LIMIT ${whole(limit) + 1} OFFSET ${whole(offset)}`
    const { columns, rows, truncated, durationMs } = await this.query(sql, {
      ...options,
      access: 'read',
      maxRows: limit,
    })
    return { columns, rows, truncated, durationMs }
  }

  /**
   * One statement, in a transaction with its own statement timeout. Through pg-cursor, so the
   * extended protocol runs it, which takes one statement only: `COMMIT; DROP …` can't step out of
   * a read-only transaction. A statement that refuses to run in a transaction (VACUUM) runs
   * alone, with write access.
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
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
        result = await readCursor(modules, client, sql, options.maxRows)
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
        result = await readCursor(modules, client, sql, options.maxRows)
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
      const rows = await this.#catalog<{ oid: string; name: string }>(
        'SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
        [unknown],
      )
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
  maxRows: number,
): Promise<CursorResult> {
  const cursor = client.query(
    new modules.Cursor(sql, undefined, { rowMode: 'array', types: AS_TEXT } as never),
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

interface CatalogTable {
  schema: string
  name: string
  kind: string
  estimate: string
  bytes: string | null
}

interface CatalogDetail {
  comment: string | null
  columns: string
  primary_key: string
  indexes: string
  constraints: string
}

interface CatalogColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  identity: string
  generated: string
  comment: string | null
}

function summary(row: CatalogTable): TableSummary {
  const estimate = Number(row.estimate)
  return {
    schema: row.schema,
    name: row.name,
    kind: KINDS[row.kind] ?? 'table',
    // -1 until the table is first vacuumed or analyzed.
    estimatedRows: row.kind === 'v' || estimate < 0 ? null : Math.round(estimate),
    bytes: row.bytes === null ? null : Number(row.bytes),
  }
}

function column(c: CatalogColumn): Column {
  const generated =
    c.identity === 'a'
      ? 'always'
      : c.identity === 'd'
        ? 'by default'
        : c.generated === 's'
          ? 'stored'
          : c.generated === 'v'
            ? 'virtual'
            : null
  return {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    default: c.default,
    generated,
    comment: c.comment,
  }
}

/** A PostgreSQL identifier, double-quoted, so any name is taken as a name and never as SQL. */
export function quote(identifier: string): string {
  if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) {
    throw new DbAdminError(`"${identifier}" isn't a name.`, 400, 'bad-request')
  }
  return `"${identifier.replaceAll('"', '""')}"`
}

/** A whole number for SQL text, which only ever takes numbers checked here. */
function whole(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DbAdminError(`${value} isn't a whole number.`, 400, 'bad-request')
  }
  return value
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
