/** The databases a connection can be, chosen by its URL's scheme. */
export type DriverKind = 'postgres' | 'mysql' | 'sqlite'

/**
 * What a connection may do. `read` runs every query in a read-only transaction; `write` runs
 * anything the database role may. The role is the real boundary: give read connections a role
 * that may only SELECT.
 */
export type Access = 'read' | 'write'

/** A database the tool may open. Its URL stays on the server; the browser knows its name only. */
export interface ConnectionConfig {
  /** Lowercase letters, digits and hyphens: how the API and the browser name it. */
  name: string
  url: string
  access: Access
  /** Shown instead of the name. */
  label?: string
  /** Which environment it is, shown as the connection's color; `production` asks before writes. */
  tag?: ConnectionTag
  /** Shown wherever people run SQL on it, such as what a heavy statement does to the host. */
  warning?: string
  /**
   * Which of its server's databases it opens, where a connection opens one database at a time
   * (PostgreSQL): `all`, the default, every one its login may connect to, the URL's first; `one`,
   * the URL's only, for a login with more privileges than the tool should show.
   */
  databases?: 'all' | 'one'
}

/** A connection's environment, as a color: production red, staging orange, and so on. */
export type ConnectionTag = 'local' | 'development' | 'testing' | 'staging' | 'production'

/** What a driver can do, so the UI offers only that. */
export interface Capabilities {
  /** Tables live in schemas (PostgreSQL), not straight in the database (SQLite). */
  schemas: boolean
  /** Schema changes roll back with their transaction. */
  transactionalDdl: boolean
  /**
   * A running statement can be stopped: by Cancel, and at the time limit. Not in PGlite, which
   * runs on the host's own thread.
   */
  cancel: boolean
  /**
   * The server's other databases open from the connection, by name. The API sets it: a driver
   * offers them with `databases()` and `withDatabase()`, and a connection may be pinned to its own.
   */
  databases?: boolean
}

/** What a schema-tree entry is: SQLite and MySQL have tables and views, PostgreSQL the rest too. */
export type TableKind =
  'table' | 'view' | 'materialized-view' | 'foreign-table' | 'partitioned-table'

/** A table or view in the schema tree. */
export interface TableSummary {
  schema: string
  name: string
  kind: TableKind
  /** The planner's estimate, null when the database has none yet (never analyzed). */
  estimatedRows: number | null
  /** On disk, with indexes and TOAST; null for views. */
  bytes: number | null
}

/** One column of a table, as Structure shows it. */
export interface Column {
  name: string
  /** As the database spells it, such as `numeric(10,2)` or `timestamp with time zone`. */
  type: string
  nullable: boolean
  /** The default's SQL, such as `now()`. */
  default: string | null
  /**
   * `always` or `by default` for identity columns; `stored` or `virtual` (PostgreSQL 18) for
   * generated ones, whose expression is then the default.
   */
  generated: 'always' | 'by default' | 'stored' | 'virtual' | null
  comment: string | null
}

/** An index, a foreign key or a check, with the SQL that defines it. */
export interface Definition {
  name: string
  definition: string
}

/** A table whole, as Structure shows it: its columns, keys, indexes and checks. */
export interface TableDetail extends TableSummary {
  columns: Column[]
  /** The primary key's columns, in order; empty without one. */
  primaryKey: string[]
  indexes: Definition[]
  foreignKeys: Definition[]
  checks: Definition[]
  comment: string | null
}

/** One column of a result: its name, and the type the database gave it. */
export interface ResultColumn {
  name: string
  /** The column's type as the database names it, such as `bigint` or `jsonb`. */
  type: string
}

/**
 * Rows as arrays beside one column list. Values are the database's own text, so nothing is lost
 * on the way: a timestamp keeps its zone, a numeric or int8 its digits, JSON its spelling.
 */
export interface ResultSet {
  columns: ResultColumn[]
  rows: (string | null)[][]
  /** More rows were left than the limit allowed. */
  truncated: boolean
  durationMs: number
}

/** What one statement returned: its rows, and what the database says it did. */
export interface QueryResult extends ResultSet {
  /** The statement's command, the first word of its tag: `SELECT`, `UPDATE`, `CREATE`. */
  command: string
  /** Rows the statement changed or returned, as the database counts them; null if it doesn't say. */
  affectedRows: number | null
}

/** How a filter compares a column with its value, as TablePlus's filter bar offers. */
export type FilterOperator =
  | '='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>='
  | 'in'
  | 'not in'
  | 'between'
  | 'not between'
  | 'is null'
  | 'is not null'
  | 'like'
  | 'not like'
  | 'contains'
  | 'not contains'
  | 'starts with'
  | 'ends with'

/**
 * One condition of the filter bar; a page's filters must all hold. `in` and `not in` take a list,
 * `between` two values, `is null` none, the rest one. Values go to the database as parameters,
 * never into the SQL, and it reads them as the column's type.
 */
export interface Filter {
  column: string
  operator: FilterOperator
  value?: string | readonly string[]
}

/** One page of a table, filtered and in the order given. */
export interface RowsRequest {
  schema: string
  table: string
  limit: number
  offset: number
  order?: readonly { column: string; descending?: boolean }[]
  filters?: readonly Filter[]
}

/**
 * One edit staged in the grid. Values are text, as the grid shows them; the database reads each
 * as its column's type. An update or delete names its row by `key`, the primary key's values.
 */
export type Change =
  | { type: 'insert'; values: Readonly<Record<string, string | null>> }
  | {
      type: 'update'
      key: Readonly<Record<string, string>>
      values: Readonly<Record<string, string | null>>
    }
  | { type: 'delete'; key: Readonly<Record<string, string>> }

/** The staged changes as the SQL that commits them, and whether it ran. */
export interface ApplyResult {
  /** Each change's statement, its values written in, for the review before ⌘S commits. */
  statements: string[]
  /** False for a dry run. */
  applied: boolean
}

/** An export's file: CSV, a JSON array of objects, or SQL with an INSERT a row. */
export type ExportFormat = 'csv' | 'json' | 'sql'

/** How a database's SQL quotes names and values, for statements shown to people and exports. */
export interface SqlDialect {
  identifier(name: string): string
  literal(value: string | null): string
}

/** The server a connection reaches, for the toolbar. */
export interface ServerInfo {
  /** Such as `PostgreSQL`. */
  product: string
  /** Such as `17.11`. */
  version: string
  database: string
  user: string
}

/** The databases a connection's login may open on its server, for the database picker. */
export interface DatabaseList {
  /** The one the driver opened. */
  current: string
  /** By name, the current one among them. */
  databases: string[]
}

/** How many rows one statement may send back, and how long it may run. */
export interface Limits {
  /** Rows sent back at most; the rest are cut, and the result says so. */
  maxRows: number
  /** How long one statement may run, in milliseconds. */
  timeoutMs: number
}

/** How a driver runs one statement: with the connection's access, inside the limits. */
export interface QueryOptions extends Limits {
  access: Access
  /** Aborting it stops the query on the server. */
  signal?: AbortSignal
}

/** One database's engine. Drivers open their connections on first use. */
export interface Driver {
  readonly kind: DriverKind
  readonly capabilities: Capabilities
  tables(): Promise<TableSummary[]>
  /** Null when there's no such table. */
  table(schema: string, name: string): Promise<TableDetail | null>
  rows(request: RowsRequest, options: Omit<QueryOptions, 'access' | 'maxRows'>): Promise<ResultSet>
  /** How many rows match the filters: an exact count, which can take a while on a big table. */
  count(
    request: Pick<RowsRequest, 'schema' | 'table' | 'filters'>,
    options: Omit<QueryOptions, 'access' | 'maxRows'>,
  ): Promise<number>
  info(): Promise<ServerInfo>
  /**
   * The changes in one transaction: all of them or none. Each update and delete must change
   * exactly one row, or nothing is saved (someone else changed it, or its key isn't unique).
   * `dryRun` only returns the statements.
   */
  apply(
    target: { schema: string; table: string },
    changes: readonly Change[],
    options: { timeoutMs: number; dryRun?: boolean },
  ): Promise<ApplyResult>
  /** Every row that matches, a batch at a time, in a read-only transaction. */
  export(
    request: Pick<RowsRequest, 'schema' | 'table' | 'filters' | 'order'>,
    options: { timeoutMs: number },
  ): AsyncGenerator<{ columns: { name: string }[]; rows: (string | null)[][] }>
  readonly sql: SqlDialect
  /** One statement. */
  query(sql: string, options: QueryOptions): Promise<QueryResult>
  /**
   * The server's databases its login may open, where a connection opens one at a time
   * (PostgreSQL). Absent where it has one (SQLite) or shows the rest as schemas (MySQL).
   */
  databases?(): Promise<DatabaseList>
  /**
   * A driver for another of the server's databases, with the same login and settings. It connects
   * on first use; whoever asked for it closes it.
   */
  withDatabase?(name: string): Driver
  close(): Promise<void>
}

/** Who is asking, as the host's `authorize()` says. */
export interface Viewer {
  /** Recorded in the audit log, such as a user id or an email. */
  id: string
  /**
   * This viewer's access to a connection, at most the connection's own; null hides it. Without
   * it, every connection at its own access.
   */
  access?(connection: ConnectionConfig): Access | null
}

/** A statement run, for the audit log. */
export interface AuditEvent {
  at: string
  viewer: string
  connection: string
  /** The database it ran on, when it wasn't the connection's own. */
  database?: string
  action: 'query' | 'rows' | 'count' | 'apply' | 'export' | 'cancel'
  /** The SQL run, or for `rows`, the table read. */
  statement: string
  durationMs: number
  /** Rows returned or changed. */
  rows?: number
  error?: string
}
