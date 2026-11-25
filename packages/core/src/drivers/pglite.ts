import { DbAdminError, QueryError } from '../errors.ts'
import { refuseBeyondReadingPostgres } from './read-only.ts'
import type {
  ApplyResult,
  Capabilities,
  Change,
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
import {
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
  stalledExport,
  where,
  whole,
} from './sql.ts'

/** What this driver uses of a PGlite instance: shapes only, so the core needs no PGlite. */
export interface PGliteQueryable {
  query(
    sql: string,
    params?: unknown[],
    options?: {
      rowMode?: 'array' | 'object'
      parsers?: Record<number, (value: string) => unknown>
      serializers?: Record<number, (value: unknown) => string>
    },
  ): Promise<{
    rows: unknown[]
    fields: { name: string; dataTypeID: number }[]
    affectedRows?: number
  }>
  exec(sql: string): Promise<unknown>
}

/** A PGlite instance the host already has open, such as the CMS's embedded database. */
export interface PGliteLike extends PGliteQueryable {
  /** Its parsers by type OID: the types it would turn into JavaScript values. */
  parsers: Record<number, unknown>
  /** How it writes a JavaScript value of each type for the server, by type OID. */
  serializers?: Record<number | string, (value: never) => string>
  /** Runs alone: the host's own queries wait until it's done. */
  transaction<T>(
    callback: (tx: PGliteQueryable & { rollback(): Promise<void> }) => Promise<T>,
  ): Promise<T>
  /** Whether a transaction is open, as the server last said. Not every version has it. */
  isInTransaction?(): boolean
}

const asIs = (value: string) => value

const NOT_IN_TRANSACTION = '25001'
const EXPORT_BATCH = 1_000
const CURSOR = 'otw_db_cursor'
const FIX = 'otw_db_fix'

/** The statements a cursor can read from, past the comments and brackets before them. */
const READS_ROWS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()*(?:SELECT|WITH|VALUES|TABLE)\b/i

/**
 * What a statement can leave on a session past its own transaction. The host shares the one
 * connection, so all of it is the host's to find again as it left it: its settings (search_path,
 * a role), its temporary tables, prepared statements, cursors, LISTENs and advisory locks.
 */
interface SessionState {
  /** The settings SET for the session, by name, and always `role` and `session_authorization`. */
  settings: Record<string, string>
  temp: { oid: number; drop: string }[]
  prepared: string[]
  cursors: string[]
  channels: string[]
  /** Advisory locks as pg_locks has them: classid, objid, objsubid, mode. */
  locks: [number, number, number, string][]
  /**
   * Settings no catalog lists, a plugin's or an app's own (`app.tenant`), by the names a
   * statement's text gives; null for one that was never set.
   */
  custom: Record<string, string | null> | null
}

const STATE_SQL = `SELECT json_build_object(
  'settings', (SELECT json_object_agg(s.name, s.setting) FROM (
                 SELECT name, setting FROM pg_catalog.pg_settings WHERE source = 'session'
                 -- Who the session runs as: pg_settings leaves these two out.
                 UNION ALL SELECT 'role', current_setting('role')
                 UNION ALL SELECT 'session_authorization', session_user::text) s),
  'temp', (SELECT coalesce(json_agg(json_build_object('oid', c.oid::bigint, 'drop',
             format('DROP %s IF EXISTS pg_temp.%I CASCADE', CASE c.relkind WHEN 'v' THEN 'VIEW'
               WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE'
               ELSE 'TABLE' END, c.relname))), '[]')
             FROM pg_catalog.pg_class c
            WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')),
  'prepared', (SELECT coalesce(json_agg(name), '[]') FROM pg_catalog.pg_prepared_statements),
  'cursors', (SELECT coalesce(json_agg(name), '[]') FROM pg_catalog.pg_cursors),
  'channels', (SELECT coalesce(json_agg(c), '[]') FROM pg_catalog.pg_listening_channels() c),
  'locks', (SELECT coalesce(json_agg(json_build_array(classid::bigint, objid::bigint, objsubid, mode)), '[]')
              FROM pg_catalog.pg_locks
             WHERE locktype = 'advisory' AND pid = pg_catalog.pg_backend_pid() AND granted),
  'custom', (SELECT json_object_agg(n, pg_catalog.current_setting(n, true)) FROM unnest($1::text[]) n))::text`

/** A setting's name, as RESET takes it: `search_path`, or an extension's `app.tenant`. */
const SETTING = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/

async function sessionState(
  on: PGliteQueryable,
  custom: readonly string[] = [],
): Promise<SessionState> {
  const { rows } = await on.query(STATE_SQL, [custom], { rowMode: 'array', parsers: {} })
  return JSON.parse((rows as [string][])[0]![0]) as SessionState
}

/**
 * The names in a statement that could be settings of a plugin's or an app's own: words with a
 * dot between them, as `app.tenant` is, and as `public.users` is too, which costs nothing to ask
 * after. pg_settings has none of them, so what a statement set can only be found by name.
 */
function customSettings(sql: string): string[] {
  const names = new Set<string>()
  for (const [name] of sql.matchAll(
    /[A-Za-z_][A-Za-z0-9_]*(?:"?\s*\.\s*"?[A-Za-z_][A-Za-z0-9_$]*)+/g,
  )) {
    const plain = name.replace(/["\s]/g, '').toLowerCase()
    if (SETTING.test(plain)) names.add(plain)
    if (names.size === 64) break
  }
  return [...names]
}

/**
 * The statements that put a session back as `before` has it, from how it is `now`. `listens`:
 * inside a transaction about to commit, where a LISTEN it ran doesn't show yet.
 */
function repairs(
  before: SessionState,
  now: SessionState,
  listens: boolean,
): { sql: string; values?: unknown[] }[] {
  const fixes: { sql: string; values?: unknown[] }[] = []
  // Who the session runs as comes first: the rest may need the host's own privileges.
  const first = ['session_authorization', 'role']
  const names = [...new Set([...Object.keys(before.settings), ...Object.keys(now.settings)])].sort(
    (a, b) => first.indexOf(b) - first.indexOf(a),
  )
  for (const name of names) {
    const was = before.settings[name]
    if (was === now.settings[name]) continue
    if (was !== undefined)
      fixes.push({ sql: 'SELECT set_config($1, $2, false)', values: [name, was] })
    else if (SETTING.test(name)) fixes.push({ sql: `RESET ${name}` })
  }
  for (const [name, was] of Object.entries(before.custom ?? {})) {
    if (was === (now.custom ?? {})[name]) continue
    if (was !== null) fixes.push({ sql: 'SELECT set_config($1, $2, false)', values: [name, was] })
    else if (SETTING.test(name)) fixes.push({ sql: `RESET ${name}` })
  }
  const had = new Set(before.temp.map((t) => t.oid))
  for (const made of now.temp) if (!had.has(made.oid)) fixes.push({ sql: made.drop })
  const added = (list: (s: SessionState) => string[]) =>
    list(now).filter((name) => !list(before).includes(name))
  for (const name of added((s) => s.cursors)) fixes.push({ sql: `CLOSE ${quote(name)}` })
  for (const name of added((s) => s.prepared)) fixes.push({ sql: `DEALLOCATE ${quote(name)}` })
  if (listens) {
    // What the transaction listened to isn't listed until it commits: all of it goes, and the
    // host's own channels are listened to again, in the same commit.
    fixes.push({ sql: 'UNLISTEN *' })
    for (const name of before.channels) fixes.push({ sql: `LISTEN ${quote(name)}` })
  } else {
    for (const name of added((s) => s.channels)) fixes.push({ sql: `UNLISTEN ${quote(name)}` })
  }
  const held = new Set(before.locks.map((l) => l.join(' ')))
  const taken = now.locks.filter((l) => !held.has(l.join(' ')))
  if (taken.length && !before.locks.length) fixes.push({ sql: 'SELECT pg_advisory_unlock_all()' })
  else {
    for (const [classid, objid, objsubid, mode] of taken) {
      const shared = mode === 'ShareLock' ? '_shared' : ''
      // One key of 64 bits (objsubid 1), or two of 32: as pg_locks splits them.
      const key =
        objsubid === 1
          ? '($1::bigint << 32) | $2::bigint'
          : '$1::bigint::oid::int4, $2::bigint::oid::int4'
      // Taken more than once, it's let go as often: until PostgreSQL says it wasn't held.
      fixes.push({
        sql: `SELECT count(*) FROM generate_series(1, 1000) WHERE pg_advisory_unlock${shared}(${key})`,
        values: [classid, objid],
      })
    }
  }
  return fixes
}

/**
 * Puts the session back as `before` has it. Always while the host's queries are still waiting
 * for the statement's transaction: what they set the moment it ends is theirs, and seen from
 * after it, nothing would tell it from what the statement left. Inside a transaction
 * (`savepoints`), each fix is on its own savepoint, so one that fails doesn't take the
 * transaction's work with it.
 */
async function restoreSession(
  on: PGliteQueryable,
  before: SessionState,
  savepoints: boolean,
  listens = false,
): Promise<void> {
  const now = await sessionState(on, Object.keys(before.custom ?? {}))
  for (const fix of repairs(before, now, listens)) {
    try {
      if (savepoints) await on.query(`SAVEPOINT ${FIX}`)
      await on.query(fix.sql, fix.values)
      if (savepoints) await on.query(`RELEASE SAVEPOINT ${FIX}`)
    } catch (error) {
      console.error(`otw-db: could not reset the PGlite session (${fix.sql})`, error)
      if (savepoints) await on.query(`ROLLBACK TO SAVEPOINT ${FIX}`)
    }
  }
}

/**
 * Rolls back the transaction `tx` is in and leaves it usable, outside any transaction but still
 * PGlite's exclusive one: nothing of the host's runs until its callback returns.
 */
async function undo(tx: PGliteQueryable): Promise<void> {
  await tx.query('ROLLBACK')
}

/**
 * A driver for a PGlite database a host already has open, such as an OTW CMS site's embedded one:
 * PGlite takes one process, so the tool uses the host's instance rather than opening the files.
 * Each statement runs in PGlite's exclusive transaction, so it never interleaves with the host's
 * queries; reads roll back. The connection is the host's own, so after someone's statement the
 * session is put back as the host had it: what the statement set (SET, SET ROLE, temporary
 * tables, LISTEN, session locks) is undone before the host's next query, and what the host set
 * is left alone.
 *
 * PGlite runs on the host's own thread and can't be interrupted: a heavy statement holds the host
 * until it finishes. Tell people so where they choose this connection.
 */
export function pgliteDriver(client: PGliteLike, options: PGliteOptions = {}): Driver {
  return new PGliteDriver(client, options)
}

/** How the PGlite driver behaves, where the defaults don't suit. */
export interface PGliteOptions {
  /**
   * How long an export may sit between two batches, its rows unread, before it's ended and the
   * rows the database kept for it are let go. Defaults to 5 minutes.
   */
  exportIdleMs?: number
}

class PGliteDriver implements Driver {
  readonly kind = 'postgres'
  readonly capabilities: Capabilities = { schemas: true, transactionalDdl: true, cancel: false }
  readonly sql = sqlDialect
  readonly #client: PGliteLike
  readonly #exportIdleMs: number
  readonly #typeNames = new Map<number, string>()
  #asText: Record<number, (value: string) => unknown> = {}

  constructor(client: PGliteLike, options: PGliteOptions) {
    this.#client = client
    this.#exportIdleMs = options.exportIdleMs ?? EXPORT_IDLE_MS
  }

  /**
   * A parser for every type PGlite would parse, that leaves the server's text as it is. Built
   * again when PGlite learns new types (an enum's array, say).
   */
  get #text(): Record<number, (value: string) => unknown> {
    const types = Object.keys(this.#client.parsers)
    if (types.length !== Object.keys(this.#asText).length) {
      this.#asText = Object.fromEntries(types.map((oid) => [oid, asIs]))
    }
    return this.#asText
  }

  /**
   * How a parameter is written for the server. PGlite's own way wants a JavaScript value of the
   * parameter's type: a Uint8Array for bytea, and it refuses text. The grid has every value as
   * the server's own text, which the server reads as any type: so text goes as it is, a list of
   * text (a filter's IN) as an array of it, and anything else as PGlite would write it.
   */
  readonly #asGiven = new Proxy({} as Record<number, (value: unknown) => string>, {
    get: (_, oid) => (value: unknown) => {
      if (typeof value === 'string') return value
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        return `{${value.map((v: string) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`
      }
      const own = this.#client.serializers?.[oid as string] as
        ((value: unknown) => string) | undefined
      return own ? own(value) : String(value)
    },
  })

  /** One of the driver's own statements, in a read-only transaction that rolls back. */
  async #read(
    sql: string,
    params: unknown[] = [],
    rowMode: 'array' | 'object' = 'array',
    timeoutMs = 30_000,
  ) {
    try {
      return await this.#client.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY')
        await tx.query(`SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
        const answer = await tx.query(sql, params, {
          rowMode,
          parsers: this.#text,
          serializers: this.#asGiven,
        })
        await tx.rollback()
        return answer
      })
    } catch (error) {
      throw toError(error)
    }
  }

  /**
   * Someone's statement, read through a cursor where it's one a cursor takes, so only the rows
   * that will be shown (and one more, to say there are more) are built in the host's memory.
   * PGlite hands a query's whole result over at once, in the host's process: a million rows asked
   * for are a million rows held. What a cursor can't read (SHOW, EXPLAIN, INSERT … RETURNING)
   * runs as it is, and so does a statement PostgreSQL refuses, so its error says where in the
   * person's own SQL it is.
   */
  async #limited(tx: PGliteQueryable, sql: string, maxRows: number) {
    const options = { rowMode: 'array' as const, parsers: this.#text }
    if (!READS_ROWS.test(sql)) return tx.query(sql, [], options)
    await tx.query(`SAVEPOINT ${CURSOR}`)
    try {
      await tx.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${sql}`)
    } catch {
      await tx.query(`ROLLBACK TO SAVEPOINT ${CURSOR}`)
      return tx.query(sql, [], options)
    }
    return tx.query(`FETCH ${whole(maxRows) + 1} FROM ${CURSOR}`, [], options)
  }

  async #named(fields: { name: string; dataTypeID: number }[]) {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID))].filter(
      (oid) => !this.#typeNames.has(oid),
    )
    if (unknown.length) {
      const { rows } = await this.#read(TYPE_NAMES_SQL, [unknown], 'object')
      for (const row of rows as { oid: string; name: string }[])
        this.#typeNames.set(Number(row.oid), row.name)
    }
    return fields.map((f) => ({
      name: f.name,
      type: this.#typeNames.get(f.dataTypeID) ?? 'unknown',
    }))
  }

  async tables(): Promise<TableSummary[]> {
    return ((await this.#read(TABLES_SQL, [], 'object')).rows as CatalogTable[]).map(summary)
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const [row] = (await this.#read(TABLE_SQL, [schema, name], 'object')).rows as (CatalogTable &
      CatalogDetail)[]
    return row ? detail(row) : null
  }

  async rows(
    { schema, table, limit, offset, order = [], filters = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)} LIMIT ${whole(limit) + 1} OFFSET ${whole(offset)}`
    const started = performance.now()
    const { rows, fields } = await this.#read(sql, parameters.values, 'array', options.timeoutMs)
    const list = rows as (string | null)[][]
    const truncated = list.length > limit
    return {
      columns: await this.#named(fields),
      rows: truncated ? list.slice(0, limit) : list,
      truncated,
      durationMs: Math.round(performance.now() - started),
    }
  }

  async count(
    { schema, table, filters = [] }: Pick<RowsRequest, 'schema' | 'table' | 'filters'>,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<number> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT count(*) FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}`
    const { rows } = await this.#read(sql, parameters.values, 'array', options.timeoutMs)
    return Number((rows as string[][])[0]![0])
  }

  async info(): Promise<ServerInfo> {
    const [row] = (await this.#read(INFO_SQL, [], 'object')).rows as Omit<ServerInfo, 'product'>[]
    return { product: 'PGlite', ...row!, version: versionOf(row!.version) }
  }

  /**
   * One statement. Reads in a read-only transaction that rolls back; writes in one that commits,
   * or alone where PostgreSQL refuses one (VACUUM). Either way the session is then as the host
   * had it.
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    if (options.signal?.aborted) throw new DbAdminError('The query was canceled.', 409, 'canceled')
    const started = performance.now()
    const write = options.access !== 'read'
    if (!write) refuseBeyondReadingPostgres(sql)
    let result
    try {
      result = await this.#client.transaction(async (tx) => {
        // Before anything is set: SET LOCAL would read as the session's own.
        const before = await sessionState(tx, customSettings(sql))
        if (!write) await tx.query('SET TRANSACTION READ ONLY')
        await tx.query(`SET LOCAL statement_timeout = ${whole(options.timeoutMs)}`)
        let answer
        let failure: unknown
        try {
          answer = await this.#limited(tx, sql, options.maxRows)
        } catch (error) {
          failure = error
        }
        if (write && failure === undefined) {
          // Committed with the statement, so the host's next query already finds its own.
          await restoreSession(tx, before, true, /listen/i.test(sql))
          return answer!
        }
        // A read, or a statement that failed: undone here by hand, and then what a rollback
        // doesn't undo (a prepared statement, a session's lock) is put back, still in the
        // host's way. PGlite ends its transaction after this, and finds none: that's all.
        await undo(tx)
        await restoreSession(tx, before, false).catch((error: unknown) =>
          console.error('otw-db: could not reset the PGlite session', error),
        )
        if (failure !== undefined) throw failure
        return answer!
      })
    } catch (error) {
      if (!write || (error as { code?: string }).code !== NOT_IN_TRANSACTION) throw toError(error)
      try {
        // What refuses to run in a transaction (VACUUM, CREATE DATABASE) sets nothing on a session.
        result = await this.#client.query(sql, [], { rowMode: 'array', parsers: this.#text })
      } catch (alone) {
        throw toError(alone)
      }
    }
    const rows = result.rows as (string | null)[][]
    const truncated = rows.length > options.maxRows
    return {
      columns: await this.#named(result.fields),
      rows: truncated ? rows.slice(0, options.maxRows) : rows,
      truncated,
      command: (
        /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(\w+)/.exec(sql)?.[1] ?? ''
      ).toUpperCase(),
      affectedRows: result.fields.length
        ? truncated
          ? null
          : rows.length
        : (result.affectedRows ?? null),
      durationMs: Math.round(performance.now() - started),
    }
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
    try {
      await this.#client.transaction(async (tx) => {
        await tx.query(`SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
        for (const statement of statements) {
          if (statement.check) {
            // As the grid read them: every value the server's own text.
            const { rows } = await tx.query(statement.check.text, statement.check.values, {
              rowMode: 'array',
              parsers: this.#text,
              serializers: this.#asGiven,
            })
            refuseChanged(dialect, statement, rows[0] as (string | null)[] | undefined)
          }
          const { affectedRows } = await tx.query(statement.text, statement.values, {
            serializers: this.#asGiven,
          })
          if (statement.oneRow && affectedRows !== 1) {
            const why =
              affectedRows === 0
                ? 'its row is gone or its key changed'
                : `its key matched ${affectedRows} rows`
            throw new DbAdminError(
              `Nothing was saved: ${why}.\n${statement.shown}`,
              409,
              'conflict',
            )
          }
        }
      })
    } catch (error) {
      throw toError(error)
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
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    const catalog = await this.#read(EXPORT_COLUMNS_SQL, [schema, table], 'array', timeoutMs)
    // A cursor WITH HOLD, declared in a read-only transaction that ends at once: the database
    // keeps the rows as they were at that moment, on its own side, and hands them over a batch
    // at a time. Asked for whole, they would all be built in the host's memory at once; read
    // through a cursor inside one transaction, they would hold the host's queries for as long
    // as the file takes to download.
    const cursor = `otw_db_export_${crypto.randomUUID().replaceAll('-', '')}`
    const close = () => this.#client.query(`CLOSE ${cursor}`).catch(() => {})
    try {
      await this.#client.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY')
        await tx.query(`SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
        await tx.query(
          `DECLARE ${cursor} NO SCROLL CURSOR WITH HOLD FOR ${sql}`,
          parameters.values,
          {
            serializers: this.#asGiven,
          },
        )
      })
    } catch (error) {
      throw toError(error)
    }
    // Nobody reading, the rows kept for the export would stay in the host's database for good.
    let stalled = false
    const stall = () => {
      stalled = true
      void close()
    }
    try {
      for (let first = true; ; first = false) {
        const { rows, fields } = await this.#client.query(
          `FETCH ${EXPORT_BATCH} FROM ${cursor}`,
          [],
          {
            rowMode: 'array',
            parsers: this.#text,
          },
        )
        if (rows.length || first) {
          const columns = exportColumns(
            fields.map((f) => f.name),
            catalog.rows as (string | null)[][],
          )
          const waiting = setTimeout(stall, this.#exportIdleMs)
          waiting.unref?.()
          try {
            yield { columns, rows: rows as (string | null)[][] }
          } finally {
            clearTimeout(waiting)
          }
          if (stalled) throw stalledExport(this.#exportIdleMs)
        }
        if (rows.length < EXPORT_BATCH) break
      }
    } catch (error) {
      throw toError(error)
    } finally {
      await close()
    }
  }

  /**
   * PGlite's exclusive transaction, held open until `end`: the host's queries wait meanwhile, so
   * whoever opens it must end it, and soon.
   */
  session(mode: 'snapshot' | 'write'): Promise<Session> {
    const client = this.#client
    const parsers = () => this.#text
    return new Promise<Session>((resolve, reject) => {
      let opened = false
      let before: SessionState | undefined
      const done = client.transaction(async (tx) => {
        if (mode === 'snapshot') {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        } else before = await sessionState(tx)
        let decide!: (commit: boolean) => void
        const decided = new Promise<boolean>((r) => (decide = r))
        let ended = false
        opened = true
        resolve({
          exclusive: true,
          // PGlite keeps what the server says after each query, as its own transactions need.
          ...(client.isInTransaction ? { inTransaction: () => client.isInTransaction!() } : {}),
          async query(sql, values) {
            try {
              const result = await tx.query(sql, values, { rowMode: 'array', parsers: parsers() })
              return { rows: result.rows as (string | null)[][] }
            } catch (error) {
              throw toError(error)
            }
          },
          async end(commit) {
            if (ended) return
            ended = true
            decide(commit)
            try {
              await done
            } catch (error) {
              throw toError(error)
            }
          },
        })
        if (!(await decided)) {
          // Rolled back by hand, and then what a rollback leaves (prepared statements, session
          // locks) is put back while the host's queries still wait: see restoreSession.
          await undo(tx)
          if (before) {
            await restoreSession(tx, before, false).catch((error: unknown) =>
              console.error('otw-db: could not reset the PGlite session', error),
            )
          }
          return
        }
        // As after every write: what the session set (a restore's SETs, its locks, a LISTEN) is
        // undone inside the transaction, so the host's queries waiting for it find their own.
        if (before) await restoreSession(tx, before, true, true)
      })
      done.catch((error: unknown) => {
        if (!opened) reject(toError(error))
      })
    })
  }

  /** The host owns the instance: nothing to close here. */
  async close(): Promise<void> {}
}

/** PGlite's errors as the API's: the server's refusals carry a severity, as pg's do. */
function toError(error: unknown): Error {
  if (error instanceof DbAdminError) return error
  const e = error as {
    message?: string
    code?: string
    position?: string
    detail?: string
    hint?: string
    severity?: string
  }
  if (e?.severity || e?.code) {
    return new QueryError(e.message ?? 'The query failed.', e.code, {
      ...(e.position ? { position: Number(e.position) } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.hint ? { hint: e.hint } : {}),
    })
  }
  return new DbAdminError(`PGlite failed: ${e?.message ?? String(error)}`, 500, 'pglite-failed')
}
