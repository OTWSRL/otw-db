import type { Connection as CallbackConnection } from 'mysql2'
import type * as MySqlModule from 'mysql2/promise'
import type { FieldPacket, Pool, PoolConnection, PoolOptions } from 'mysql2/promise'
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
  TableKind,
  TableSummary,
} from '../types.ts'
import { changeStatement, orderBy, Parameters, where, whole, type Dialect } from './sql.ts'

type MySql = typeof MySqlModule

let module: Promise<MySql> | undefined

/** mysql2, imported on the first MySQL connection, so other hosts never load it. */
function loadMySql(): Promise<MySql> {
  // Imported where the host runs, not bundled (see postgres.ts).
  module ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'mysql2/promise').then(
    // CommonJS: its exports arrive as the default.
    (m) => (m as unknown as { default?: MySql }).default ?? (m as unknown as MySql),
    (error: unknown) => {
      module = undefined
      throw new DbAdminError(
        `MySQL and MariaDB connections need the mysql2 package: npm install mysql2 (${(error as Error).message})`,
        500,
        'driver-missing',
      )
    },
  )
  return module
}

/** A name in backticks, so any name is taken as a name and never as SQL. */
export function backtick(identifier: string): string {
  if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) {
    throw new DbAdminError(`"${identifier}" isn't a name.`, 400, 'bad-request')
  }
  return `\`${identifier.replaceAll('`', '``')}\``
}

/** A value as a MySQL literal to show: backslashes and quotes escaped, as the default sql_mode reads. */
export function mysqlLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

/**
 * A value written into the statement as utf8mb4 bytes in hex. Nothing in it can end a string, so
 * it's safe whatever sql_mode says about backslashes; a coercible literal, it takes the column's
 * collation in comparisons.
 */
function hexLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  return value === '' ? "''" : `_utf8mb4 X'${Buffer.from(value, 'utf8').toString('hex')}'`
}

const dialect: Dialect = {
  identifier: backtick,
  literal: mysqlLiteral,
  placeholder: () => '?',
  inline: hexLiteral,
  text: (expression) => `CAST(${expression} AS CHAR)`,
  // LIKE follows the column's collation; the default ones ignore case.
  ilike: 'LIKE',
  // Not \, which the server's sql_mode may or may not take as an escape in string literals.
  likeEscapeChar: '|',
  likeEscape: " ESCAPE '|'",
  inList: (expression, values, parameter) =>
    `${expression} IN (${values.map(parameter).join(', ')})`,
  insertDefaults: '() VALUES ()',
}

const SYSTEM_SCHEMAS = "('mysql', 'information_schema', 'performance_schema', 'sys')"
const EXPORT_BATCH = 1_000
/** "Query execution was interrupted": KILL QUERY's answer. */
const INTERRUPTED = 1317

/** MySQL's column types by number, as the protocol sends them. */
const TYPES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  242: 'vector',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
}
const STRINGS = new Set([15, 249, 250, 251, 252, 253, 254])
/** The binary character set: a string column holding bytes, not text. */
const BINARY = 63

/**
 * A MySQL or MariaDB driver for `url`. It connects on first use, with a pool of up to three
 * connections, each closed after 10 s unused.
 */
export function mysqlDriver(url: string): Driver {
  return new MySqlDriver(url)
}

class MySqlDriver implements Driver {
  readonly kind = 'mysql'
  readonly capabilities: Capabilities = { schemas: true, transactionalDdl: false, cancel: true }
  readonly sql = { identifier: backtick, literal: mysqlLiteral }
  readonly #config: PoolOptions
  #pool: Promise<{ pool: Pool; mysql: MySql }> | undefined

  constructor(url: string) {
    // mysql2 reads mysql:// addresses; mariadb:// is the same thing.
    const address = url.replace(/^mariadb:/i, 'mysql:')
    this.#config = {
      uri: address,
      connectionLimit: 3,
      maxIdle: 3,
      idleTimeout: 10_000,
      // One statement a query: `COMMIT; DROP …` is a syntax error.
      multipleStatements: false,
      // Rows matched, not rows changed: an update to the same value still counts its row.
      flags: ['FOUND_ROWS', '-LOCAL_FILES'],
      connectAttributes: { program_name: 'otw-db' },
    }
  }

  #open(): Promise<{ pool: Pool; mysql: MySql }> {
    this.#pool ??= loadMySql().then((mysql) => {
      const pool = mysql.createPool(this.#config)
      // A connection the server drops while idle would otherwise take the process with it.
      pool.pool.on('connection', (connection: CallbackConnection) =>
        connection.on('error', (error: Error) =>
          console.error('otw-db: a MySQL connection failed', error),
        ),
      )
      return { pool, mysql }
    })
    return this.#pool
  }

  async #connect(): Promise<{ connection: PoolConnection; mysql: MySql }> {
    const { pool, mysql } = await this.#open()
    try {
      return { connection: await pool.getConnection(), mysql }
    } catch (error) {
      throw new ConnectionError(`Could not connect to MySQL: ${(error as Error).message}`)
    }
  }

  /** Runs `sql` on a connection, stopping it with KILL QUERY at the timeout or on abort. */
  async #run(
    connection: PoolConnection,
    mysql: MySql,
    sql: string,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ rows: (string | null)[][]; fields: FieldPacket[]; affected: number | null }> {
    let stopped: 'timeout' | 'cancel' | null = null
    const stop = (why: 'timeout' | 'cancel') => {
      if (stopped) return
      stopped = why
      void this.#kill(mysql, connection.threadId)
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const abort = () => stop('cancel')
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) throw new DbAdminError('The query was canceled.', 409, 'canceled')
      const [result, fields] = await connection.query({ sql, rowsAsArray: true, typeCast: asBytes })
      if (stopped) throw interrupted(stopped, timeoutMs)
      if (!Array.isArray(result)) {
        return { rows: [], fields: [], affected: (result as { affectedRows: number }).affectedRows }
      }
      const list = fields as FieldPacket[]
      return {
        rows: (result as unknown[][]).map((row) => toText(row, list)),
        fields: list,
        affected: null,
      }
    } catch (error) {
      if (stopped && !(error instanceof DbAdminError)) throw interrupted(stopped, timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  /** KILL QUERY on a connection of its own: the busy one can't take it. You may kill your own. */
  async #kill(mysql: MySql, threadId: number): Promise<void> {
    try {
      const killer = await mysql.createConnection(this.#config)
      try {
        await killer.query(`KILL QUERY ${whole(threadId)}`)
      } finally {
        await killer.end()
      }
    } catch (error) {
      console.error('otw-db: could not stop a MySQL query', error)
    }
  }

  async #catalog(sql: string): Promise<(string | null)[][]> {
    const { connection, mysql } = await this.#connect()
    try {
      return (await this.#run(connection, mysql, sql, { timeoutMs: 30_000 })).rows
    } catch (error) {
      throw toError(error)
    } finally {
      connection.release()
    }
  }

  async tables(): Promise<TableSummary[]> {
    const rows = await this.#catalog(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    )
    return rows.map(summary)
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const at = `TABLE_SCHEMA = ${hexLiteral(schema)} AND TABLE_NAME = ${hexLiteral(name)}`
    const [table] = await this.#catalog(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT
         FROM information_schema.TABLES WHERE ${at}`,
    )
    if (!table) return null
    const columns = await this.#catalog(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT,
              GENERATION_EXPRESSION
         FROM information_schema.COLUMNS WHERE ${at} ORDER BY ORDINAL_POSITION`,
    )
    const indexes = await this.#catalog(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
        WHERE ${at} ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    )
    const keys = await this.#catalog(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME,
              REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE ${at} AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    )
    const checks = await this.#catalog(
      `SELECT c.CONSTRAINT_NAME, c.CHECK_CLAUSE
         FROM information_schema.TABLE_CONSTRAINTS t
         JOIN information_schema.CHECK_CONSTRAINTS c
           ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA = ${hexLiteral(schema)} AND t.TABLE_NAME = ${hexLiteral(name)}
          AND t.CONSTRAINT_TYPE = 'CHECK'
        ORDER BY c.CONSTRAINT_NAME`,
      // MySQL before 8.0.16 has no CHECK_CONSTRAINTS (and enforced no checks).
    ).catch(() => [] as (string | null)[][])

    const grouped = <T>(
      rows: (string | null)[][],
      by: (row: (string | null)[]) => string,
      make: (rows: (string | null)[][]) => T,
    ) => {
      const groups = new Map<string, (string | null)[][]>()
      for (const row of rows) groups.set(by(row), [...(groups.get(by(row)) ?? []), row])
      return [...groups.entries()].map(([name, group]) => ({ name, value: make(group) }))
    }
    const target = `${backtick(schema)}.${backtick(name)}`
    return {
      ...summary(table),
      comment: table[5] || null,
      columns: columns.map(column),
      primaryKey: indexes.filter((i) => i[0] === 'PRIMARY').map((i) => i[2]!),
      indexes: grouped(
        indexes,
        (i) => i[0]!,
        (group) => group,
      ).map(({ name: index, value }) => ({
        name: index,
        definition:
          index === 'PRIMARY'
            ? `PRIMARY KEY (${value.map((i) => backtick(i[2]!)).join(', ')})`
            : `CREATE ${value[0]![1] === '0' ? 'UNIQUE ' : ''}INDEX ${backtick(index)} ON ${target} (${value.map((i) => backtick(i[2]!)).join(', ')})`,
      })),
      foreignKeys: grouped(
        keys,
        (k) => k[0]!,
        (group) => group,
      ).map(({ name: key, value }) => ({
        name: key,
        definition: `FOREIGN KEY (${value.map((k) => backtick(k[1]!)).join(', ')}) REFERENCES ${backtick(value[0]![2]!)}.${backtick(value[0]![3]!)}(${value.map((k) => backtick(k[4]!)).join(', ')})`,
      })),
      checks: checks.map((c) => ({ name: c[0]!, definition: `CHECK (${c[1]})` })),
    }
  }

  async rows(
    { schema, table, limit, offset, order = [], filters = [] }: RowsRequest,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<ResultSet> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT * FROM ${backtick(schema)}.${backtick(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)} LIMIT ${whole(limit) + 1} OFFSET ${whole(offset)}`
    const started = performance.now()
    const { rows, fields } = await this.#pooled(sql, options)
    const truncated = rows.length > limit
    return {
      columns: fields.map(named),
      rows: truncated ? rows.slice(0, limit) : rows,
      truncated,
      durationMs: Math.round(performance.now() - started),
    }
  }

  async count(
    { schema, table, filters = [] }: Pick<RowsRequest, 'schema' | 'table' | 'filters'>,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<number> {
    const parameters = new Parameters(dialect)
    const sql = `SELECT COUNT(*) FROM ${backtick(schema)}.${backtick(table)}${where(dialect, filters, parameters)}`
    return Number((await this.#pooled(sql, options)).rows[0]![0])
  }

  /** One of this driver's own statements, on a pooled connection it hands back after. */
  async #pooled(sql: string, options: { timeoutMs: number; signal?: AbortSignal }) {
    const { connection, mysql } = await this.#connect()
    let broken = false
    try {
      return await this.#run(connection, mysql, sql, options)
    } catch (error) {
      broken = !(error instanceof DbAdminError) && !(error as { sqlMessage?: string }).sqlMessage
      throw toError(error)
    } finally {
      if (broken) connection.destroy()
      else connection.release()
    }
  }

  async info(): Promise<ServerInfo> {
    const [[version, database, user]] = (await this.#catalog(
      'SELECT VERSION(), DATABASE(), CURRENT_USER()',
    )) as [[string, string | null, string]]
    return {
      product: /mariadb/i.test(version) ? 'MariaDB' : 'MySQL',
      version: /^\d+(\.\d+)*/.exec(version)?.[0] ?? version,
      database: database ?? '',
      user,
    }
  }

  /**
   * One statement of the viewer's, on a connection closed after it: a statement may leave
   * anything on its session (variables, user locks, temporary tables). Read access makes the
   * session read-only, which outlasts the implicit commit MySQL makes before DDL, so `DROP` is
   * refused too; and caps what a SELECT returns at the row limit, plus one to tell it was cut.
   */
  async query(sql: string, options: QueryOptions): Promise<QueryResult> {
    const { connection, mysql } = await this.#connect()
    const started = performance.now()
    try {
      if (options.access === 'read') await connection.query('SET SESSION TRANSACTION READ ONLY')
      await connection.query(`SET SESSION sql_select_limit = ${whole(options.maxRows) + 1}`)
      const { rows, fields, affected } = await this.#run(connection, mysql, sql, options)
      const truncated = rows.length > options.maxRows
      return {
        columns: fields.map(named),
        rows: truncated ? rows.slice(0, options.maxRows) : rows,
        truncated,
        command: (/^\s*(\w+)/.exec(stripComments(sql))?.[1] ?? '').toUpperCase(),
        affectedRows: affected ?? (truncated ? null : rows.length),
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      throw toError(error)
    } finally {
      connection.destroy()
    }
  }

  async apply(
    { schema, table }: { schema: string; table: string },
    changes: readonly Change[],
    { timeoutMs, dryRun = false }: { timeoutMs: number; dryRun?: boolean },
  ): Promise<ApplyResult> {
    const target = `${backtick(schema)}.${backtick(table)}`
    const statements = changes.map((change) => changeStatement(dialect, target, change))
    const shown = statements.map((s) => s.shown)
    if (dryRun) return { statements: shown, applied: false }
    const { connection, mysql } = await this.#connect()
    try {
      await connection.query('START TRANSACTION')
      for (const statement of statements) {
        const { affected } = await this.#run(connection, mysql, statement.text, { timeoutMs })
        if (statement.oneRow && affected !== 1) {
          const why =
            affected === 0
              ? 'its row is gone or its key changed'
              : `its key matched ${affected} rows`
          throw new DbAdminError(`Nothing was saved: ${why}.\n${statement.shown}`, 409, 'conflict')
        }
      }
      await connection.query('COMMIT')
      return { statements: shown, applied: true }
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {})
      throw toError(error)
    } finally {
      connection.destroy()
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
    const sql = `SELECT * FROM ${backtick(schema)}.${backtick(table)}${where(dialect, filters, parameters)}${orderBy(dialect, order)}`
    const { connection } = await this.#connect()
    // Rows come as the server sends them; a stop on the way leaves the connection mid-result.
    let finished = false
    try {
      await connection.query(`SET SESSION max_execution_time = ${whole(timeoutMs)}`).catch(() => {})
      // The callback connection underneath streams; the promise one doesn't.
      const stream = (connection.connection as unknown as CallbackConnection)
        .query({ sql, rowsAsArray: true, typeCast: asBytes })
        .stream({ highWaterMark: EXPORT_BATCH })
      let fields: FieldPacket[] = []
      stream.on('fields', (f: FieldPacket[]) => (fields = f))
      let batch: (string | null)[][] = []
      let first = true
      for await (const row of stream as AsyncIterable<unknown[]>) {
        batch.push(toText(row, fields))
        if (batch.length === EXPORT_BATCH) {
          yield { columns: fields.map((f) => ({ name: f.name })), rows: batch }
          batch = []
          first = false
        }
      }
      if (batch.length || first)
        yield { columns: fields.map((f) => ({ name: f.name })), rows: batch }
      finished = true
    } catch (error) {
      throw toError(error)
    } finally {
      if (finished) connection.release()
      else connection.destroy()
    }
  }

  async close(): Promise<void> {
    const opened = this.#pool
    this.#pool = undefined
    if (opened) await (await opened).pool.end()
  }
}

/** Every value as the server's bytes; `toText` reads them as text, or bytes as hex. */
function asBytes(field: { buffer(): Buffer | null }): Buffer | null {
  return field.buffer()
}

function toText(row: unknown[], fields: readonly FieldPacket[]): (string | null)[] {
  return row.map((value, i) => {
    if (value === null || value === undefined) return null
    const field = fields[i]
    const type = field?.columnType ?? 0
    const bytes = value as Buffer
    // Bytes, not text: binary strings, BIT and geometry, shown as hex as MySQL writes them.
    if ((STRINGS.has(type) && field?.characterSet === BINARY) || type === 16 || type === 255) {
      return `0x${bytes.toString('hex').toUpperCase()}`
    }
    return bytes.toString('utf8')
  })
}

function named(field: FieldPacket): { name: string; type: string } {
  const type = TYPES[field.columnType ?? -1] ?? 'unknown'
  const binary = field.characterSet === BINARY && STRINGS.has(field.columnType ?? -1)
  return { name: field.name, type: binary ? type.replace(/char|text/, 'binary') : type }
}

function summary(row: (string | null)[]): TableSummary {
  const view = row[2] === 'VIEW' || row[2] === 'SYSTEM VIEW'
  return {
    schema: row[0]!,
    name: row[1]!,
    kind: (view ? 'view' : 'table') as TableKind,
    estimatedRows: view || row[3] === null ? null : Number(row[3]),
    bytes: view || row[4] === null ? null : Number(row[4]),
  }
}

function column(row: (string | null)[]): Column {
  const extra = (row[4] ?? '').toLowerCase()
  const generated = extra.includes('stored generated')
    ? 'stored'
    : extra.includes('virtual generated')
      ? 'virtual'
      : extra.includes('auto_increment')
        ? 'by default'
        : null
  return {
    name: row[0]!,
    type: row[1]!,
    nullable: row[2] === 'YES',
    default:
      generated === 'stored' || generated === 'virtual' ? (row[6] ?? null) : (row[3] ?? null),
    generated,
    comment: row[5] || null,
  }
}

function stripComments(sql: string): string {
  return sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|#[^\n]*\n)*/, '')
}

function interrupted(why: 'timeout' | 'cancel', timeoutMs: number): DbAdminError {
  return why === 'cancel'
    ? new DbAdminError('The query was canceled.', 409, 'canceled')
    : new QueryError(`The statement ran past its ${timeoutMs} ms limit and was stopped.`, '70100')
}

/** mysql2's errors as the API's: the server's refusals are the statement's, the rest the connection's. */
function toError(error: unknown): Error {
  if (error instanceof DbAdminError) return error
  const e = error as {
    message?: string
    sqlMessage?: string
    sqlState?: string
    errno?: number
    fatal?: boolean
  }
  if (e?.sqlMessage && !e.fatal) {
    const code = e.errno === INTERRUPTED ? '70100' : e.sqlState
    return new QueryError(e.sqlMessage, code)
  }
  return new ConnectionError(`The MySQL connection failed: ${e?.message ?? String(error)}`)
}
