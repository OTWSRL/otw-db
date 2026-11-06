import { DbAdminError, QueryError } from '../errors.ts'
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

/** What this driver uses of a PGlite instance: shapes only, so the core needs no PGlite. */
export interface PGliteQueryable {
  query(
    sql: string,
    params?: unknown[],
    options?: {
      rowMode?: 'array' | 'object'
      parsers?: Record<number, (value: string) => unknown>
    },
  ): Promise<{
    rows: unknown[]
    fields: { name: string; dataTypeID: number }[]
    affectedRows?: number
  }>
  exec(sql: string): Promise<unknown>
}

export interface PGliteLike extends PGliteQueryable {
  /** Its parsers by type OID: the types it would turn into JavaScript values. */
  parsers: Record<number, unknown>
  /** Runs alone: the host's own queries wait until it's done. */
  transaction<T>(
    callback: (tx: PGliteQueryable & { rollback(): Promise<void> }) => Promise<T>,
  ): Promise<T>
}

const asIs = (value: string) => value

const NOT_IN_TRANSACTION = '25001'
const EXPORT_BATCH = 1_000

/**
 * A driver for a PGlite database a host already has open, such as an OTW CMS site's embedded one:
 * PGlite takes one process, so the tool uses the host's instance rather than opening the files.
 * Each statement runs in PGlite's exclusive transaction, so it never interleaves with the host's
 * queries; reads roll back; a write is followed by DISCARD ALL, so nothing it set (SET, SET ROLE,
 * temporary tables, session locks) stays on the connection the host shares.
 *
 * PGlite runs on the host's own thread and can't be interrupted: a heavy statement holds the host
 * until it finishes. Tell people so where they choose this connection.
 */
export function pgliteDriver(client: PGliteLike): Driver {
  return new PGliteDriver(client)
}

class PGliteDriver implements Driver {
  readonly kind = 'postgres'
  readonly capabilities: Capabilities = { schemas: true, transactionalDdl: true, cancel: false }
  readonly sql = { identifier: quote, literal }
  readonly #client: PGliteLike
  readonly #typeNames = new Map<number, string>()
  #asText: Record<number, (value: string) => unknown> = {}

  constructor(client: PGliteLike) {
    this.#client = client
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

  /** One statement in a read-only transaction that rolls back. */
  async #read(
    sql: string,
    params: unknown[] = [],
    rowMode: 'array' | 'object' = 'array',
    timeoutMs = 30_000,
  ) {
    try {
      const result = await this.#client.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY')
        await tx.query(`SET LOCAL statement_timeout = ${whole(timeoutMs)}`)
        const answer = await tx.query(sql, params, { rowMode, parsers: this.#text })
        await tx.rollback()
        return answer
      })
      // Session advisory locks outlast a rollback.
      await this.#client.query('SELECT pg_advisory_unlock_all()')
      return result
    } catch (error) {
      throw toError(error)
    }
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
   * or alone where PostgreSQL refuses one (VACUUM), then DISCARD ALL.
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    if (options.signal?.aborted) throw new DbAdminError('The query was canceled.', 409, 'canceled')
    const started = performance.now()
    let result
    if (options.access === 'read') {
      result = await this.#read(sql, [], 'array', options.timeoutMs)
    } else {
      try {
        result = await this.#client.transaction(async (tx) => {
          await tx.query(`SET LOCAL statement_timeout = ${whole(options.timeoutMs)}`)
          return tx.query(sql, [], { rowMode: 'array', parsers: this.#text })
        })
      } catch (error) {
        if ((error as { code?: string }).code !== NOT_IN_TRANSACTION) throw toError(error)
        result = await this.#client
          .query(sql, [], { rowMode: 'array', parsers: this.#text })
          .catch((e: unknown) => {
            throw toError(e)
          })
      } finally {
        await this.#client
          .exec('DISCARD ALL')
          .catch((error: unknown) =>
            console.error('otw-db: could not reset the PGlite session', error),
          )
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
          const { affectedRows } = await tx.query(statement.text, statement.values)
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
  ): AsyncGenerator<{ columns: { name: string }[]; rows: (string | null)[][] }> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${quote(schema)}.${quote(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    // PGlite has no cursor to read from bit by bit: the rows come at once, then go out in batches.
    const { rows, fields } = await this.#read(sql, parameters.values, 'array', timeoutMs)
    const columns = fields.map((f) => ({ name: f.name }))
    const list = rows as (string | null)[][]
    for (let at = 0; at === 0 || at < list.length; at += EXPORT_BATCH) {
      yield { columns, rows: list.slice(at, at + EXPORT_BATCH) }
    }
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
