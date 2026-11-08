import { DbAdminError } from '../errors.ts'
import { literal, quote } from '../drivers/postgres-catalog.ts'
import type { Session } from '../types.ts'
import * as Q from './catalog.ts'
import { BACKUP_VERSION, headerLine, trailerLine, type BackupHeader } from './format.ts'

/*
 * A PostgreSQL backup as SQL, written from the catalog in one read-only snapshot. In order:
 *
 *   1. each schema emptied (or made, with its owner and privileges, when the server lacks it);
 *   2. the extensions: those its objects need, then the database's others where the server has them;
 *   3. types, functions, sequences, tables and views, each after what it depends on;
 *   4. the rows, then where each sequence had got to;
 *   5. keys, indexes, foreign keys, triggers, rules, row-level security and policies, statistics,
 *      materialized views refreshed;
 *   6. comments, owners and privileges.
 *
 * What it can't write (aggregates, operators, C functions…) is listed in the header, never left
 * out unsaid. Roles aren't in a backup: an owner, grant or policy that names a role the restoring
 * server lacks is skipped, with a notice.
 */

/** PostgreSQL 14: older servers lack catalog columns the backup reads. */
export const MIN_SERVER_VERSION = 140000
/** Rows an INSERT carries at most, and about how many bytes. */
const ROWS_PER_INSERT = 500
const BYTES_PER_INSERT = 1_000_000
const FETCH = 1_000

export interface Server {
  version: number
  server: string
  database: string
  user: string
}

/** A schema the backup dialog offers, with what's in it and whether it's ticked at first. */
export interface SchemaChoice {
  name: string
  owner: string
  /** The login owns it, or is a member of its owner. */
  mine: boolean
  tables: number
  objects: number
  extensions: number
  /** Ticked at first: the login's own, unless it holds extensions' objects alone. */
  selected: boolean
}

/** Settings for the snapshot, then who and where it is. Refuses servers older than 14. */
export async function prepare(session: Session): Promise<Server> {
  for (const sql of Q.SESSION_SQL) await session.query(sql)
  const server = await json<Server>(session, Q.SERVER_SQL)
  if (server.version < MIN_SERVER_VERSION) {
    throw new DbAdminError(
      `Backups need PostgreSQL 14 or newer; this server is ${server.server}.`,
      400,
      'server-too-old',
    )
  }
  return server
}

export async function schemaChoices(session: Session): Promise<SchemaChoice[]> {
  const schemas = await json<Omit<SchemaChoice, 'selected'>[]>(session, Q.SCHEMAS_SQL)
  return schemas.map((s) => ({
    ...s,
    tables: Number(s.tables),
    objects: Number(s.objects),
    extensions: Number(s.extensions),
    selected: s.mine && (Number(s.objects) > 0 || Number(s.extensions) === 0),
  }))
}

/** What a backup of `schemas` would leave out: per schema, and database-wide (schema null). */
export function notIncluded(
  session: Session,
  schemas: readonly string[],
): Promise<{ schema: string | null; what: string }[]> {
  return json(session, Q.NOT_INCLUDED_SQL, [schemas])
}

/**
 * The backup of `schemas`, as text pieces. The session must be a snapshot already prepared; the
 * caller ends it. `summary` is filled in as the rows go by.
 */
export async function* backupSql(
  session: Session,
  server: Server,
  schemas: readonly string[],
  now: Date,
  summary: { tables: number; rows: number } = { tables: 0, rows: 0 },
): AsyncGenerator<string> {
  const catalog = await readCatalog(session, schemas)
  const plan = new Plan(catalog)
  const header: BackupHeader = {
    format: 'otw-db',
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    database: server.database,
    server: server.server,
    serverVersion: server.version,
    schemas: [...schemas],
    roles: [...plan.roles].sort(),
    notIncluded: catalog.notIncluded,
  }
  yield headerLine(header)
  yield preamble(header)
  yield section('Schemas', plan.schemaStatements())
  yield section('Extensions', plan.extensionStatements())
  yield section('Types, functions, sequences, tables and views', plan.preData())
  for (const table of plan.dataTables()) {
    yield `\n-- Data: ${table.schema}.${table.name}\n`
    let rows = 0
    for await (const piece of tableRows(session, table)) {
      rows += piece.rows
      yield piece.sql
    }
    summary.tables += 1
    summary.rows += rows
  }
  yield section('Sequences', plan.sequenceValues())
  yield section('Keys, indexes and constraints', plan.postData())
  yield section('Comments, owners and privileges', plan.finishing())
  yield '\n'
  yield trailerLine(summary)
}

interface Acl {
  grant: { role: string | null; privilege: string; grantable: boolean }[]
  revoke: { role: string | null; privilege: string; grantable: boolean }[]
}

interface Owned {
  oid: number
  schema: string
  name: string
  owner: string
  comment: string | null
  acl: Acl | null
}

interface SchemaRow {
  name: string
  owner: string
  comment: string | null
  acl: Acl | null
  defaults: { role: string; type: string; grants: Acl['grant'] }[]
}

interface TypeRow extends Owned {
  kind: 'e' | 'c' | 'd' | 'r'
  labels: string[] | null
  attributes:
    { name: string; type: string; collation: string | null; comment: string | null }[] | null
  base: string | null
  notNull: boolean
  default: string | null
  collation: string | null
  checks: { name: string; def: string; comment: string | null }[] | null
  range: {
    subtype: string
    opclass: string | null
    collation: string | null
    diff: string | null
    multirange: string | null
  } | null
}

interface FunctionRow extends Owned {
  kind: 'f' | 'p' | 'w'
  signature: string
  def: string
}

interface SequenceSettings {
  name: string
  type: string
  start: string
  increment: string
  min: string
  max: string
  cache: string
  cycle: boolean
  last: string | null
}

interface SequenceRow extends Owned {
  settings: SequenceSettings
  unlogged: boolean
  ownedBy: { table: number; column: string } | null
}

interface ColumnRow {
  name: string
  type: string
  notNull: boolean
  default: string | null
  generated: { kind: 's' | 'v'; expr: string } | null
  identity: { kind: 'a' | 'd'; sequence: SequenceSettings } | null
  collation: string | null
  local: boolean
  comment: string | null
  acl: Acl | null
}

interface TableRow extends Owned {
  kind: 'r' | 'p'
  unlogged: boolean
  parent: number | null
  bound: string | null
  partitionKey: string | null
  options: string[] | null
  rls: boolean
  forceRls: boolean
  replicaIdentity: 'd' | 'n' | 'f' | 'i'
  replicaIndex: string | null
  columns: ColumnRow[]
  checks: { name: string; def: string; valid: boolean; comment: string | null }[]
  notNulls: {
    name: string
    column: string
    def: string
    valid: boolean
    local: boolean
    noInherit: boolean
    comment: string | null
  }[]
}

interface ViewRow extends Owned {
  kind: 'v' | 'm'
  def: string
  options: string[] | null
  populated: boolean
  columns: ColumnRow[]
}

interface ConstraintRow {
  oid: number
  name: string
  type: 'p' | 'u' | 'x' | 'f'
  table: number
  def: string
  /** A partition's, made by its parent's. */
  inherited: boolean
  partitioned: boolean
  comment: string | null
}

interface IndexRow {
  oid: number
  schema: string
  name: string
  table: number
  def: string
  clustered: boolean
  parent: number | null
  constraint: boolean
  comment: string | null
}

interface Catalog {
  schemas: SchemaRow[]
  extensions: { oid: number; name: string; schema: string }[]
  needed: number[]
  types: TypeRow[]
  functions: FunctionRow[]
  sequences: SequenceRow[]
  tables: TableRow[]
  views: ViewRow[]
  constraints: ConstraintRow[]
  indexes: IndexRow[]
  triggers: { name: string; table: number; def: string; enabled: string; comment: string | null }[]
  rules: { name: string; table: number; def: string; comment: string | null }[]
  policies: {
    name: string
    table: number
    command: string
    permissive: boolean
    roles: (string | null)[] | null
    using: string | null
    check: string | null
    comment: string | null
  }[]
  statistics: { name: string; def: string; comment: string | null }[]
  dependencies: [number, number, number, number, 'hard' | 'default'][]
  notIncluded: string[]
  user: string
}

async function readCatalog(session: Session, schemas: readonly string[]): Promise<Catalog> {
  const read = <T>(sql: string) => json<T>(session, sql, [schemas])
  // One after another: a session runs one statement at a time.
  return {
    schemas: await read(Q.SCHEMA_DETAILS_SQL),
    extensions: await json(session, Q.EXTENSIONS_SQL),
    needed: await read(Q.NEEDED_EXTENSIONS_SQL),
    types: await read(Q.TYPES_SQL),
    functions: await read(Q.FUNCTIONS_SQL),
    sequences: await read(Q.SEQUENCES_SQL),
    tables: await read(Q.TABLES_SQL),
    views: await read(Q.VIEWS_SQL),
    constraints: await read(Q.CONSTRAINTS_SQL),
    indexes: await read(Q.INDEXES_SQL),
    triggers: await read(Q.TRIGGERS_SQL),
    rules: await read(Q.RULES_SQL),
    policies: await read(Q.POLICIES_SQL),
    statistics: await read(Q.STATISTICS_SQL),
    dependencies: await json(session, Q.DEPENDENCIES_SQL),
    notIncluded: (await notIncluded(session, schemas)).map((x) => x.what),
    user: (await json<Server>(session, Q.SERVER_SQL)).user,
  }
}

/** An object made before the data, and what it waits for. */
interface Item {
  key: string
  rank: number
  schema: string
  name: string
  /** Its statements; a table's are built when it's placed, in case its defaults must wait. */
  build(deferDefaults: boolean): string[]
  /** What it needs first: `hard` can't wait, a column `default` can be set afterwards. */
  needs: Map<string, 'hard' | 'default'>
}

const key = (catalog: number, oid: number) => `${catalog}:${oid}`

/** The statements of a backup, from its catalog. */
class Plan {
  readonly roles = new Set<string>()
  readonly #catalog: Catalog
  readonly #schemas: Set<string>
  readonly #relations = new Map<number, { schema: string; name: string; kind: string }>()
  readonly #indexes = new Map<number, IndexRow>()
  /** Pre-data, in the order placed: matviews are refreshed in the same order. */
  #placed: Item[] = []
  #deferred: string[] = []

  constructor(catalog: Catalog) {
    this.#catalog = catalog
    this.#schemas = new Set(catalog.schemas.map((s) => s.name))
    for (const t of catalog.tables) this.#relations.set(t.oid, t)
    for (const v of catalog.views) this.#relations.set(v.oid, v)
    for (const s of catalog.sequences) this.#relations.set(s.oid, { ...s, kind: 'S' })
    for (const i of catalog.indexes) this.#indexes.set(i.oid, i)
    this.#collectRoles()
  }

  #name(oid: number): string {
    const relation = this.#relations.get(oid)
    if (!relation) throw new Error(`otw-db: relation ${oid} isn't in the backup`)
    return qualified(relation.schema, relation.name)
  }

  #collectRoles(): void {
    const c = this.#catalog
    const owners = [...c.types, ...c.functions, ...c.sequences, ...c.tables, ...c.views]
    for (const o of owners) {
      if (o.owner !== c.user) this.roles.add(o.owner)
      this.#aclRoles(o.acl)
    }
    for (const t of [...c.tables, ...c.views]) for (const col of t.columns) this.#aclRoles(col.acl)
    for (const s of c.schemas) {
      this.#aclRoles(s.acl)
      for (const d of s.defaults) {
        this.roles.add(d.role)
        for (const g of d.grants) if (g.role) this.roles.add(g.role)
      }
    }
    for (const p of c.policies) for (const r of p.roles ?? []) if (r) this.roles.add(r)
  }

  #aclRoles(acl: Acl | null): void {
    for (const entry of [...(acl?.grant ?? []), ...(acl?.revoke ?? [])]) {
      if (entry.role) this.roles.add(entry.role)
    }
  }

  /** Each schema emptied, or made when the server hasn't got it. */
  schemaStatements(): string[] {
    return this.#catalog.schemas.map((schema) => {
      const made: string[] = []
      if (schema.owner !== this.#catalog.user) {
        made.push(`ALTER SCHEMA ${quote(schema.name)} OWNER TO ${quote(schema.owner)}`)
      }
      made.push(...privileges(`SCHEMA ${quote(schema.name)}`, schema.acl))
      for (const d of schema.defaults) {
        const on = DEFAULT_ON[d.type]
        if (!on) continue
        for (const [grantee, grantable, list] of grouped(d.grants)) {
          made.push(
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(d.role)} IN SCHEMA ${quote(schema.name)} GRANT ${list.join(', ')} ON ${on} TO ${grantee}${grantable ? ' WITH GRANT OPTION' : ''}`,
          )
        }
      }
      if (schema.comment !== null) {
        made.push(`COMMENT ON SCHEMA ${quote(schema.name)} IS ${literal(schema.comment)}`)
      }
      return emptySchema(schema.name, made)
    })
  }

  /**
   * The database's extensions. Those in the schemas, and those their objects are seen to use (a
   * column of citext, an index with pg_trgm's operators), must be made. The rest are made where
   * the server has them, and skipped with a notice where it hasn't: a function's body may call
   * one, and PostgreSQL records nothing a body uses.
   */
  extensionStatements(): string[] {
    const needed = new Set(this.#catalog.needed.map(Number))
    return this.#catalog.extensions.map((x) => {
      const inBackup = this.#schemas.has(x.schema)
      const statements = [
        ...(inBackup ? [] : [`CREATE SCHEMA IF NOT EXISTS ${quote(x.schema)}`]),
        `CREATE EXTENSION IF NOT EXISTS ${quote(x.name)} WITH SCHEMA ${quote(x.schema)}`,
      ]
      if (inBackup || needed.has(Number(x.oid))) return statements.map((s) => `${s};`).join('\n')
      const body = `BEGIN ${statements.map((s) => `EXECUTE ${literal(s)};`).join(' ')} EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'otw-db skipped extension ${x.name.replaceAll("'", "''")}: %', SQLERRM; END`
      const tag = dollarTag(body)
      return `DO ${tag} ${body} ${tag};`
    })
  }

  /**
   * Types, functions, sequences, tables and views, each after what it needs: Kahn's order, ties
   * broken by kind, then schema, then name, so the same database gives the same file.
   */
  preData(): string[] {
    const items = this.#items().sort(
      (a, b) => a.rank - b.rank || compare(a.schema, b.schema) || compare(a.name, b.name),
    )
    const at = new Map(items.map((item, i) => [item.key, i]))
    const unmet = items.map((item) => item.needs.size)
    const dependents: number[][] = items.map(() => [])
    items.forEach((item, i) => {
      for (const need of item.needs.keys()) dependents[at.get(need)!]!.push(i)
    })
    const placed = new Array<boolean>(items.length).fill(false)
    const ready = new Heap()
    unmet.forEach((count, i) => count === 0 && ready.push(i))
    const out: string[] = []
    const place = (i: number, deferDefaults: boolean) => {
      placed[i] = true
      const item = items[i]!
      this.#placed.push(item)
      out.push(...item.build(deferDefaults))
      for (const d of dependents[i]!) if (--unmet[d]! === 0 && !placed[d]) ready.push(d)
    }
    for (let left = items.length; left > 0; left -= 1) {
      const next = ready.pop()
      if (next !== undefined) {
        if (placed[next]) {
          left += 1
          continue
        }
        place(next, false)
        continue
      }
      // A cycle: a table whose default calls a function that needs the table. The table goes
      // first and its defaults are set once the function exists.
      const waiting = (i: number) => !placed[i]
      const deferrable = items.findIndex(
        (item, i) =>
          waiting(i) &&
          [...item.needs].every(([need, how]) => placed[at.get(need)!] || how === 'default'),
      )
      // Something even that can't order: the first in line goes, and a restore says what failed.
      place(
        deferrable === -1 ? items.findIndex((_, i) => waiting(i)) : deferrable,
        deferrable !== -1,
      )
    }
    return [...out, ...this.#deferred]
  }

  #items(): Item[] {
    const c = this.#catalog
    const items: Item[] = []
    for (const t of c.types) {
      items.push({
        key: key(Q.PG_TYPE, t.oid),
        rank: t.kind === 'e' || t.kind === 'r' ? 0 : 1,
        schema: t.schema,
        name: t.name,
        build: () => typeStatements(t),
        needs: new Map(),
      })
    }
    for (const f of c.functions) {
      items.push({
        key: key(Q.PG_PROC, f.oid),
        rank: 2,
        schema: f.schema,
        name: f.name,
        build: () => [`${f.def.trimEnd()};`],
        needs: new Map(),
      })
    }
    for (const s of c.sequences) {
      items.push({
        key: key(Q.PG_CLASS, s.oid),
        rank: 3,
        schema: s.schema,
        name: s.name,
        build: () => [
          `CREATE ${s.unlogged ? 'UNLOGGED ' : ''}SEQUENCE ${qualified(s.schema, s.name)} AS ${s.settings.type}${sequenceOptions(s.settings)};`,
        ],
        needs: new Map(),
      })
    }
    for (const t of c.tables) {
      const needs = new Map<string, 'hard' | 'default'>()
      if (t.parent) needs.set(key(Q.PG_CLASS, t.parent), 'hard')
      items.push({
        key: key(Q.PG_CLASS, t.oid),
        rank: 4,
        schema: t.schema,
        name: t.name,
        build: (defer) => this.#tableStatements(t, defer),
        needs,
      })
    }
    for (const v of c.views) {
      items.push({
        key: key(Q.PG_CLASS, v.oid),
        rank: v.kind === 'v' ? 5 : 6,
        schema: v.schema,
        name: v.name,
        build: () => viewStatements(v),
        needs: new Map(),
      })
    }
    const byKey = new Map(items.map((item) => [item.key, item]))
    for (const [cat, oid, refcat, refoid, how] of c.dependencies) {
      const item = byKey.get(key(cat, oid))
      const need = key(refcat, refoid)
      if (!item || need === item.key || !byKey.has(need)) continue
      // A hard need stays hard, whatever else needs the same.
      if (item.needs.get(need) !== 'hard') item.needs.set(need, how)
    }
    return items
  }

  #tableStatements(t: TableRow, deferDefaults: boolean): string[] {
    const name = qualified(t.schema, t.name)
    const unlogged = t.unlogged ? 'UNLOGGED ' : ''
    const tail = `${t.partitionKey ? ` PARTITION BY ${t.partitionKey}` : ''}${withOptions(t.options)}`
    const after: string[] = []
    if (t.parent) {
      // A partition takes its columns from its parent.
      return [
        `CREATE ${unlogged}TABLE ${name} PARTITION OF ${this.#name(t.parent)} ${t.bound}${tail};`,
        ...t.checks
          .filter((check) => check.valid)
          .map(
            (check) => `ALTER TABLE ONLY ${name} ADD CONSTRAINT ${quote(check.name)} ${check.def};`,
          ),
      ]
    }
    const named = new Map(t.notNulls.map((n) => [n.column, n]))
    const lines = t.columns.map((column) => {
      let line = `    ${quote(column.name)} ${column.type}`
      if (column.collation) line += ` COLLATE ${column.collation}`
      if (column.generated) {
        line += ` GENERATED ALWAYS AS (${column.generated.expr}) ${column.generated.kind === 's' ? 'STORED' : 'VIRTUAL'}`
      }
      if (column.identity) {
        const s = column.identity.sequence
        line += ` GENERATED ${column.identity.kind === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (SEQUENCE NAME ${s.name}${sequenceOptions(s)})`
      }
      if (column.default !== null) {
        if (deferDefaults) {
          after.push(
            `ALTER TABLE ONLY ${name} ALTER COLUMN ${quote(column.name)} SET DEFAULT ${column.default};`,
          )
        } else line += ` DEFAULT ${column.default}`
      }
      const notNull = named.get(column.name)
      if (notNull && !notNull.valid) {
        // Checked once the rows are in, as it was made: NOT VALID.
      } else if (notNull) {
        line += ` CONSTRAINT ${quote(notNull.name)} NOT NULL${notNull.noInherit ? ' NO INHERIT' : ''}`
      } else if (column.notNull) line += ' NOT NULL'
      return line
    })
    for (const check of t.checks) {
      if (check.valid) lines.push(`    CONSTRAINT ${quote(check.name)} ${check.def}`)
    }
    this.#deferred.push(...after)
    return [`CREATE ${unlogged}TABLE ${name} (\n${lines.join(',\n')}\n)${tail};`]
  }

  /** The tables whose rows the backup holds: a partitioned table's live in its partitions. */
  dataTables(): DataTable[] {
    return this.#catalog.tables
      .filter((t) => t.kind === 'r')
      .map((t) => {
        const columns = t.columns.filter((c) => !c.generated)
        return {
          schema: t.schema,
          name: t.name,
          columns: columns.map((c) => c.name),
          overriding: columns.some((c) => c.identity?.kind === 'a'),
        }
      })
  }

  /** Where each sequence had got to, its own and identity columns' alike. */
  sequenceValues(): string[] {
    const settings = [
      ...this.#catalog.sequences.map((s) => s.settings),
      ...this.#catalog.tables.flatMap((t) =>
        t.columns.flatMap((c) => (c.identity ? [c.identity.sequence] : [])),
      ),
    ]
    return settings
      .filter((s) => s.last !== null)
      .map((s) => `SELECT pg_catalog.setval(${literal(s.name)}, ${s.last}, true);`)
  }

  postData(): string[] {
    const c = this.#catalog
    const out: string[] = []
    for (const t of c.tables) {
      const name = qualified(t.schema, t.name)
      for (const check of t.checks.filter((k) => !k.valid)) {
        out.push(`ALTER TABLE ONLY ${name} ADD CONSTRAINT ${quote(check.name)} ${check.def};`)
      }
      for (const n of t.notNulls.filter((k) => !k.valid && k.local)) {
        out.push(`ALTER TABLE ONLY ${name} ADD CONSTRAINT ${quote(n.name)} ${n.def};`)
      }
    }
    // Keys first: a foreign key needs the key it references. A partition's own key is made, then
    // attached to its parent's, as pg_dump does.
    for (const k of c.constraints.filter((k) => k.type !== 'f')) {
      out.push(`ALTER TABLE ONLY ${this.#name(k.table)} ADD CONSTRAINT ${quote(k.name)} ${k.def};`)
    }
    for (const index of c.indexes.filter((i) => !i.constraint)) out.push(`${index.def};`)
    for (const index of c.indexes) {
      const parent = index.parent === null ? undefined : this.#indexes.get(index.parent)
      if (parent) {
        out.push(
          `ALTER INDEX ${qualified(parent.schema, parent.name)} ATTACH PARTITION ${qualified(index.schema, index.name)};`,
        )
      }
      if (index.clustered) {
        out.push(`ALTER TABLE ${this.#name(index.table)} CLUSTER ON ${quote(index.name)};`)
      }
    }
    for (const t of c.tables) {
      const name = qualified(t.schema, t.name)
      if (t.replicaIdentity === 'f') out.push(`ALTER TABLE ONLY ${name} REPLICA IDENTITY FULL;`)
      if (t.replicaIdentity === 'n') out.push(`ALTER TABLE ONLY ${name} REPLICA IDENTITY NOTHING;`)
      if (t.replicaIdentity === 'i' && t.replicaIndex) {
        out.push(`ALTER TABLE ONLY ${name} REPLICA IDENTITY USING INDEX ${quote(t.replicaIndex)};`)
      }
    }
    // A partitioned table's foreign key reaches its partitions itself, and can't be ONLY.
    for (const k of c.constraints.filter((k) => k.type === 'f' && !k.inherited)) {
      const only = k.partitioned ? '' : 'ONLY '
      out.push(
        `ALTER TABLE ${only}${this.#name(k.table)} ADD CONSTRAINT ${quote(k.name)} ${k.def};`,
      )
    }
    for (const trigger of c.triggers) {
      out.push(`${trigger.def};`)
      const state = TRIGGER_STATES[trigger.enabled]
      if (state) {
        out.push(
          `ALTER TABLE ${this.#name(trigger.table)} ${state} TRIGGER ${quote(trigger.name)};`,
        )
      }
    }
    for (const rule of c.rules) out.push(rule.def.trimEnd().replace(/;?$/, ';'))
    for (const t of c.tables) {
      const name = qualified(t.schema, t.name)
      if (t.rls) out.push(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`)
      if (t.forceRls) out.push(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;`)
    }
    for (const p of c.policies) {
      const roles = (p.roles ?? [null]).map((r) => (r === null ? 'PUBLIC' : quote(r)))
      const statement = `CREATE POLICY ${quote(p.name)} ON ${this.#name(p.table)} AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${POLICY_COMMANDS[p.command] ?? 'ALL'} TO ${roles.join(', ')}${p.using ? ` USING (${p.using})` : ''}${p.check ? ` WITH CHECK (${p.check})` : ''}`
      // A policy for a role the server lacks can't be made: without it, that role has less access,
      // never more.
      out.push(p.roles?.some((r) => r !== null) ? guarded(statement) : `${statement};`)
    }
    for (const s of c.statistics) out.push(`${s.def};`)
    for (const s of c.sequences) {
      if (s.ownedBy) {
        out.push(
          `ALTER SEQUENCE ${qualified(s.schema, s.name)} OWNED BY ${this.#name(s.ownedBy.table)}.${quote(s.ownedBy.column)};`,
        )
      }
    }
    for (const item of this.#placed) {
      const view = c.views.find((v) => key(Q.PG_CLASS, v.oid) === item.key)
      if (view?.kind === 'm' && view.populated) {
        out.push(`REFRESH MATERIALIZED VIEW ${qualified(view.schema, view.name)};`)
      }
    }
    return out
  }

  /** Comments, then owners (only those that aren't the backing-up login), then privileges. */
  finishing(): string[] {
    const c = this.#catalog
    const comments: string[] = []
    const owners: string[] = []
    const grants: string[] = []
    const comment = (on: string, text: string | null) => {
      if (text !== null) comments.push(`COMMENT ON ${on} IS ${literal(text)};`)
    }
    const own = (alter: string, owner: string) => {
      if (owner !== c.user) owners.push(guarded(`ALTER ${alter} OWNER TO ${quote(owner)}`))
    }
    for (const t of c.types) {
      const name = qualified(t.schema, t.name)
      const kind = t.kind === 'd' ? 'DOMAIN' : 'TYPE'
      comment(`${kind} ${name}`, t.comment)
      for (const a of t.attributes ?? []) comment(`COLUMN ${name}.${quote(a.name)}`, a.comment)
      for (const k of t.checks ?? [])
        comment(`CONSTRAINT ${quote(k.name)} ON DOMAIN ${name}`, k.comment)
      own(`${kind} ${name}`, t.owner)
      grants.push(...privileges(`${kind} ${name}`, t.acl).map(guardedIfNamed))
    }
    for (const f of c.functions) {
      const kind = f.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'
      comment(`${kind} ${f.signature}`, f.comment)
      own(`${kind} ${f.signature}`, f.owner)
      grants.push(...privileges(`${kind} ${f.signature}`, f.acl).map(guardedIfNamed))
    }
    for (const s of c.sequences) {
      const name = qualified(s.schema, s.name)
      comment(`SEQUENCE ${name}`, s.comment)
      // A sequence a column owns has its table's owner, and PostgreSQL won't change it alone.
      if (!s.ownedBy) own(`SEQUENCE ${name}`, s.owner)
      grants.push(...privileges(`SEQUENCE ${name}`, s.acl).map(guardedIfNamed))
    }
    for (const r of [...c.tables, ...c.views]) {
      const name = qualified(r.schema, r.name)
      const kind = 'def' in r ? (r.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW') : 'TABLE'
      comment(`${kind} ${name}`, r.comment)
      for (const col of r.columns) {
        comment(`COLUMN ${name}.${quote(col.name)}`, col.comment)
        grants.push(...privileges(`TABLE ${name}`, col.acl, quote(col.name)).map(guardedIfNamed))
      }
      own(`${kind} ${name}`, r.owner)
      grants.push(...privileges(`TABLE ${name}`, r.acl).map(guardedIfNamed))
      if ('checks' in r) {
        for (const k of [...r.checks, ...r.notNulls.filter((n) => n.local)]) {
          comment(`CONSTRAINT ${quote(k.name)} ON ${name}`, k.comment)
        }
      }
    }
    for (const k of c.constraints) {
      if (k.type === 'f' && k.inherited) continue
      comment(`CONSTRAINT ${quote(k.name)} ON ${this.#name(k.table)}`, k.comment)
    }
    for (const i of c.indexes) {
      if (!i.constraint) comment(`INDEX ${qualified(i.schema, i.name)}`, i.comment)
    }
    for (const t of c.triggers)
      comment(`TRIGGER ${quote(t.name)} ON ${this.#name(t.table)}`, t.comment)
    for (const r of c.rules) comment(`RULE ${quote(r.name)} ON ${this.#name(r.table)}`, r.comment)
    for (const p of c.policies)
      comment(`POLICY ${quote(p.name)} ON ${this.#name(p.table)}`, p.comment)
    for (const s of c.statistics) comment(`STATISTICS ${s.name}`, s.comment)
    return [...comments, ...owners, ...grants]
  }
}

interface DataTable {
  schema: string
  name: string
  columns: string[]
  /** It has a GENERATED ALWAYS identity column, whose values an INSERT must be told to keep. */
  overriding: boolean
}

/** A table's rows as INSERTs, read a batch at a time through a cursor. */
async function* tableRows(
  session: Session,
  table: DataTable,
): AsyncGenerator<{ sql: string; rows: number }> {
  const name = qualified(table.schema, table.name)
  if (!table.columns.length) {
    // Nothing to insert but the rows themselves: every column is generated.
    const [[count]] = (await session.query(`SELECT count(*) FROM ONLY ${name}`)).rows as [[string]]
    const rows = Number(count)
    if (rows) yield { sql: `INSERT INTO ${name} DEFAULT VALUES;\n`.repeat(rows), rows }
    return
  }
  const columns = table.columns.map(quote)
  // Every value as its type's own text: it reads back the same, whatever the type.
  await session.query(
    `DECLARE otw_db_rows NO SCROLL CURSOR FOR SELECT ${columns.map((c) => `${c}::text`).join(', ')} FROM ONLY ${name}`,
  )
  const head = `INSERT INTO ${name} (${columns.join(', ')}) ${table.overriding ? 'OVERRIDING SYSTEM VALUE ' : ''}VALUES\n`
  let tuples: string[] = []
  let bytes = 0
  const flush = () => {
    const piece = { sql: `${head}${tuples.join(',\n')};\n`, rows: tuples.length }
    tuples = []
    bytes = 0
    return piece
  }
  for (;;) {
    const { rows } = await session.query(`FETCH FORWARD ${FETCH} FROM otw_db_rows`)
    if (!rows.length) break
    for (const row of rows) {
      const tuple = `(${row.map(literal).join(', ')})`
      tuples.push(tuple)
      bytes += tuple.length
      if (tuples.length >= ROWS_PER_INSERT || bytes >= BYTES_PER_INSERT) yield flush()
    }
  }
  if (tuples.length) yield flush()
  await session.query('CLOSE otw_db_rows')
}

function typeStatements(t: TypeRow): string[] {
  const name = qualified(t.schema, t.name)
  switch (t.kind) {
    case 'e':
      return [
        `CREATE TYPE ${name} AS ENUM (${(t.labels ?? []).map((l) => literal(l)).join(', ')});`,
      ]
    case 'c': {
      const attributes = (t.attributes ?? []).map(
        (a) => `    ${quote(a.name)} ${a.type}${a.collation ? ` COLLATE ${a.collation}` : ''}`,
      )
      return [`CREATE TYPE ${name} AS (\n${attributes.join(',\n')}\n);`]
    }
    case 'd': {
      let statement = `CREATE DOMAIN ${name} AS ${t.base}`
      if (t.collation) statement += ` COLLATE ${t.collation}`
      if (t.default !== null) statement += ` DEFAULT ${t.default}`
      if (t.notNull) statement += ' NOT NULL'
      return [
        `${statement};`,
        ...(t.checks ?? []).map(
          (k) => `ALTER DOMAIN ${name} ADD CONSTRAINT ${quote(k.name)} ${k.def};`,
        ),
      ]
    }
    case 'r': {
      const r = t.range!
      const options = [`SUBTYPE = ${r.subtype}`]
      if (r.opclass) options.push(`SUBTYPE_OPCLASS = ${r.opclass}`)
      if (r.collation) options.push(`COLLATION = ${r.collation}`)
      if (r.diff) options.push(`SUBTYPE_DIFF = ${r.diff}`)
      if (r.multirange) options.push(`MULTIRANGE_TYPE_NAME = ${r.multirange}`)
      return [`CREATE TYPE ${name} AS RANGE (${options.join(', ')});`]
    }
  }
}

function viewStatements(v: ViewRow): string[] {
  const name = qualified(v.schema, v.name)
  const query = v.def.trim().replace(/;$/, '')
  const statements =
    v.kind === 'v'
      ? [`CREATE VIEW ${name}${withOptions(v.options)} AS\n${query};`]
      : [`CREATE MATERIALIZED VIEW ${name}${withOptions(v.options)} AS\n${query}\n  WITH NO DATA;`]
  for (const column of v.columns) {
    if (column.default !== null) {
      statements.push(
        `ALTER VIEW ${name} ALTER COLUMN ${quote(column.name)} SET DEFAULT ${column.default};`,
      )
    }
  }
  return statements
}

function sequenceOptions(s: SequenceSettings): string {
  return ` START WITH ${s.start} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} CACHE ${s.cache}${s.cycle ? ' CYCLE' : ''}`
}

function withOptions(options: string[] | null): string {
  return options?.length ? ` WITH (${options.join(', ')})` : ''
}

/** The grants and revokes that give an object its privileges; `column` for a column's. */
function privileges(on: string, acl: Acl | null, column?: string): string[] {
  if (!acl) return []
  const list = (privileges: string[]) =>
    privileges.map((p) => (column ? `${p} (${column})` : p)).join(', ')
  return [
    ...grouped(acl.revoke).map(([grantee, , p]) => `REVOKE ${list(p)} ON ${on} FROM ${grantee}`),
    ...grouped(acl.grant).map(
      ([grantee, grantable, p]) =>
        `GRANT ${list(p)} ON ${on} TO ${grantee}${grantable ? ' WITH GRANT OPTION' : ''}`,
    ),
  ]
}

/** Privileges grouped by grantee and grant option: SELECT and INSERT to "app". */
function grouped(
  entries: Acl['grant'],
): [grantee: string, grantable: boolean, privileges: string[]][] {
  const groups = new Map<string, { grantee: string; grantable: boolean; privileges: string[] }>()
  for (const e of entries) {
    const grantee = e.role === null ? 'PUBLIC' : quote(e.role)
    const id = `${grantee} ${e.grantable}`
    const group = groups.get(id) ?? { grantee, grantable: e.grantable, privileges: [] }
    group.privileges.push(e.privilege)
    groups.set(id, group)
  }
  return [...groups.values()].map((g) => [g.grantee, g.grantable, g.privileges])
}

/** A statement that names a role: skipped, with a notice, where the role is missing. */
function guardedIfNamed(statement: string): string {
  return / (?:TO|FROM) PUBLIC(?: WITH GRANT OPTION)?$/.test(statement)
    ? `${statement};`
    : guarded(statement)
}

/**
 * `statement`, run so that a missing role or a privilege the restoring login lacks skips it with
 * a notice instead of failing the restore.
 */
export function guarded(statement: string): string {
  const tag = dollarTag(statement)
  return `DO ${tag} BEGIN EXECUTE ${literal(statement)}; EXCEPTION WHEN undefined_object OR insufficient_privilege THEN RAISE NOTICE 'otw-db skipped: %', SQLERRM; END ${tag};`
}

/**
 * A schema emptied of what a backup makes again, or made, with `made` run after, when the server
 * hasn't got it. Emptying keeps the schema itself, its owner and its privileges as they are. It
 * drops extensions, tables, views, sequences, functions and types; operators, aggregates and the
 * like, which a backup can't hold, stay.
 */
export function emptySchema(schema: string, made: string[]): string {
  const target = literal(schema)
  const notMember = (catalog: number, oid: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e WHERE e.classid = ${catalog} AND e.objid = ${oid} AND e.deptype = 'e')`
  const then = made
    .map(
      (statement) =>
        `    BEGIN EXECUTE ${literal(statement)}; EXCEPTION WHEN undefined_object OR insufficient_privilege THEN RAISE NOTICE 'otw-db skipped: %', SQLERRM; END;`,
    )
    .join('\n')
  const body = `
DECLARE
  target constant text := ${target};
  drop_it text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = target) THEN
    EXECUTE pg_catalog.format('CREATE SCHEMA %I', target);
${then}
    RETURN;
  END IF;
  -- Each statement is written before any runs: one that a CASCADE has made pointless finds IF EXISTS.
  FOREACH drop_it IN ARRAY ARRAY(
    SELECT d.sql FROM (
      SELECT 1 AS step, x.extname AS name, pg_catalog.format('DROP EXTENSION IF EXISTS %I CASCADE', x.extname) AS sql
        FROM pg_catalog.pg_extension x JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace
       WHERE n.nspname = target
      UNION ALL
      SELECT CASE WHEN c.relkind IN ('v', 'm') THEN 2 ELSE 3 END, c.relname,
             pg_catalog.format('DROP %s IF EXISTS %I.%I CASCADE', CASE c.relkind WHEN 'v' THEN 'VIEW'
               WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE'
               ELSE 'TABLE' END, target, c.relname)
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = target AND c.relkind IN ('v', 'm', 'r', 'p', 'f', 'S') AND NOT c.relispartition
         AND ${notMember(Q.PG_CLASS, 'c.oid')}
      UNION ALL
      SELECT 4, p.proname, pg_catalog.format('DROP ROUTINE IF EXISTS %s CASCADE', p.oid::pg_catalog.regprocedure)
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE n.nspname = target AND p.prokind IN ('f', 'p', 'w') AND l.lanname NOT IN ('c', 'internal')
         AND ${notMember(Q.PG_PROC, 'p.oid')}
      UNION ALL
      SELECT 5, t.typname, pg_catalog.format('DROP %s IF EXISTS %I.%I CASCADE',
               CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, target, t.typname)
        FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = target AND ${notMember(Q.PG_TYPE, 't.oid')}
         AND (t.typtype IN ('d', 'e', 'r') OR (t.typtype = 'c' AND EXISTS (
               SELECT 1 FROM pg_catalog.pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c')))
    ) d ORDER BY d.step, d.name
  ) LOOP
    EXECUTE drop_it;
  END LOOP;
END
`
  const tag = dollarTag(body)
  return `DO ${tag}${body}${tag};`
}

function section(title: string, statements: string[]): string {
  return statements.length ? `\n-- ${title}\n\n${statements.join('\n')}\n` : ''
}

function preamble(header: BackupHeader): string {
  const lines = [
    '--',
    `-- Database ${header.database} on ${header.server}: schemas ${header.schemas.join(', ')}.`,
    `-- Made ${header.createdAt} by otw-db.`,
    '--',
    '-- Restoring it replaces everything in those schemas, and drops what elsewhere depends on it.',
    '-- Restore it on the Database screen, or with psql, in one transaction:',
    '--   gunzip -c this.sql.gz | psql --single-transaction -v ON_ERROR_STOP=1 -d <database URL>',
    ...(header.notIncluded.length
      ? ['--', '-- Not in this backup:', ...header.notIncluded.map((what) => `--   ${what}`)]
      : []),
    '--',
    '',
    'SET statement_timeout = 0;',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    'SET check_function_bodies = false;',
    'SET xmloption = content;',
    'SET client_min_messages = warning;',
    'SET row_security = off;',
    "SET datestyle = 'ISO, YMD';",
    "SET intervalstyle = 'postgres';",
    '',
  ]
  return lines.join('\n')
}

const DEFAULT_ON: Record<string, string> = {
  r: 'TABLES',
  S: 'SEQUENCES',
  f: 'FUNCTIONS',
  T: 'TYPES',
}

const TRIGGER_STATES: Record<string, string> = {
  D: 'DISABLE',
  R: 'ENABLE REPLICA',
  A: 'ENABLE ALWAYS',
}

const POLICY_COMMANDS: Record<string, string> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
}

function qualified(schema: string, name: string): string {
  return `${quote(schema)}.${quote(name)}`
}

/** A dollar quote's delimiter that `text` doesn't hold. */
function dollarTag(text: string): string {
  let tag = '$otwdb$'
  for (let n = 1; text.includes(tag); n += 1) tag = `$otwdb${n}$`
  return tag
}

/** The smallest index first: the ready objects, in the order they sort. */
class Heap {
  readonly #items: number[] = []

  push(value: number): void {
    const a = this.#items
    a.push(value)
    for (let i = a.length - 1; i > 0;) {
      const parent = (i - 1) >> 1
      if (a[parent]! <= a[i]!) break
      ;[a[parent], a[i]] = [a[i]!, a[parent]!]
      i = parent
    }
  }

  pop(): number | undefined {
    const a = this.#items
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1
        const r = l + 1
        let least = i
        if (l < a.length && a[l]! < a[least]!) least = l
        if (r < a.length && a[r]! < a[least]!) least = r
        if (least === i) break
        ;[a[least], a[i]] = [a[i]!, a[least]!]
        i = least
      }
    }
    return top
  }
}

/** Binary order, as a byte-wise collation would have it: the same everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function json<T>(session: Session, sql: string, values?: unknown[]): Promise<T> {
  const { rows } = await session.query(sql, values)
  return JSON.parse(rows[0]![0]!) as T
}
