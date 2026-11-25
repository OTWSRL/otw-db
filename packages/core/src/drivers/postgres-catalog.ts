import type {
  Column,
  Definition,
  ExportColumn,
  SqlDialect,
  TableDetail,
  TableKind,
  TableSummary,
} from '../types.ts'
import { doubleQuote, type Dialect } from './sql.ts'

/*
 * PostgreSQL's catalog and SQL, shared by the drivers that speak it: pg's (a server) and PGlite's
 * (the embedded database in a host's own process).
 */

const KINDS: Record<string, TableKind> = {
  r: 'table',
  v: 'view',
  m: 'materialized-view',
  f: 'foreign-table',
  p: 'partitioned-table',
}
const RELKINDS = `('r','v','m','f','p')`

/** A name in double quotes, so any name is taken as a name and never as SQL. */
export const quote = doubleQuote

/** A value as a PostgreSQL literal, for statements shown to people and SQL exports. */
export function literal(value: string | null): string {
  if (value === null) return 'NULL'
  // standard_conforming_strings, on since PostgreSQL 9.1, keeps backslashes literal in '…'.
  return `'${value.replaceAll("'", "''")}'`
}

export const dialect: Dialect = {
  identifier: quote,
  literal,
  placeholder: (n) => `$${n}`,
  text: (expression) => `${expression}::text`,
  ilike: 'ILIKE',
  likeEscapeChar: '\\',
  likeEscape: '',
  // One array parameter, read as the column's type's array.
  inList: (expression, values, parameter) => `${expression} = ANY(${parameter(values)})`,
  insertDefaults: 'DEFAULT VALUES',
  forUpdate: ' FOR UPDATE',
}

/**
 * A value as a literal that reads the same whatever standard_conforming_strings is, as
 * quote_literal() writes them: a value with a backslash goes in an E'…' string, where a
 * backslash always escapes. In a plain '…' string a session with the setting off would read
 * `\'` as a quote, and the value could end its string there and run as SQL. A SET at the top of
 * the file wouldn't do: a client that sends the whole file at once has it parsed before the SET
 * runs.
 */
export function portableLiteral(value: string | null): string {
  if (value === null) return 'NULL'
  const quoted = value.replaceAll("'", "''")
  return value.includes('\\') ? `E'${quoted.replaceAll('\\', '\\\\')}'` : `'${quoted}'`
}

/** How PostgreSQL's SQL is written for exports: files run later, in sessions set up anyhow. */
export const sqlDialect: SqlDialect = {
  identifier: quote,
  literal: portableLiteral,
  overriding: ' OVERRIDING SYSTEM VALUE',
}

/** A table's columns an INSERT can't simply fill: generated ones, and identities numbered always. */
export const EXPORT_COLUMNS_SQL = `SELECT a.attname, a.attgenerated <> '', a.attidentity = 'a'
  FROM pg_catalog.pg_attribute a
 WHERE a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text)) AND a.attnum > 0 AND NOT a.attisdropped`

/** An export's columns, by the names its rows came with, from EXPORT_COLUMNS_SQL's rows. */
export function exportColumns(
  names: readonly string[],
  catalog: readonly (readonly (string | null)[])[],
): ExportColumn[] {
  const flags = new Map(
    catalog.map(([name, generated, identity]) => [name, { generated, identity }]),
  )
  return names.map((name) => ({
    name,
    ...(flags.get(name)?.generated === 't' ? { generated: true } : {}),
    ...(flags.get(name)?.identity === 't' ? { identity: true } : {}),
  }))
}

/** Every table and view, but the system's. */
export const TABLES_SQL = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS estimate,
              CASE WHEN c.relkind IN ('r','m') THEN pg_total_relation_size(c.oid) END AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ${RELKINDS} AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
        ORDER BY 1, 2`

/** One table: columns, primary key, indexes and constraints, as JSON. $1 schema, $2 name. */
export const TABLE_SQL = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS estimate,
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
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${RELKINDS}`

export const INFO_SQL = `SELECT current_setting('server_version') AS version, current_database() AS database,
              current_user AS user`

/**
 * The databases the login may connect to, the current one always among them: no templates, none
 * that refuse connections, none a failed DROP DATABASE left invalid (a connection limit of -2).
 */
export const DATABASES_SQL = `SELECT datname AS name, datname = current_database() AS current
  FROM pg_database
  WHERE datname = current_database()
     OR (datallowconn AND NOT datistemplate AND datconnlimit <> -2
         AND has_database_privilege(oid, 'CONNECT'))
  ORDER BY lower(datname), datname`

/** Names for type OIDs: $1 an array of them. */
export const TYPE_NAMES_SQL =
  'SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])'

export interface CatalogTable {
  schema: string
  name: string
  kind: string
  estimate: string
  bytes: string | null
}

export interface CatalogDetail {
  comment: string | null
  columns: string
  primary_key: string
  indexes: string
  constraints: string
}

export interface CatalogColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  identity: string
  generated: string
  comment: string | null
}

export function summary(row: CatalogTable): TableSummary {
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

export function column(c: CatalogColumn): Column {
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

/** A table's catalog row as the API's detail. */
export function detail(row: CatalogTable & CatalogDetail): TableDetail {
  const constraints = JSON.parse(row.constraints) as (Definition & { type: 'f' | 'c' })[]
  const pick = (type: 'f' | 'c') =>
    constraints.filter((c) => c.type === type).map(({ name, definition }) => ({ name, definition }))
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

/** The server's version without what distributions add after it, as "17.2 (Debian 17.2-1)". */
export function versionOf(version: string): string {
  return version.split(' ')[0]!
}
