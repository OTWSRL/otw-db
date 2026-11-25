import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { backupSql, prepare } from '../src/backup/dump.ts'
import { readHeader } from '../src/backup/format.ts'
import { refuseBlocked, restorePlan, restoreSql } from '../src/backup/restore.ts'
import { postgresUrlAt } from '../src/drivers/postgres.ts'
import { postgresDriver, type Driver } from '../src/index.ts'

/*
 * What a backup can't hold (a table that inherits another, a typed table, a foreign table, an
 * aggregate) must neither break the backup of what's beside it, nor be destroyed by a restore
 * that says it leaves it alone.
 */

const url = inject('postgresUrl')
const SOURCE = 'otw_db_kept_source'
const TARGET = 'otw_db_kept_target'
const EMPTY = 'otw_db_kept_empty'
const WHEN = new Date('2026-11-25T12:00:00Z')

const FIXTURE = `
CREATE TABLE public.parent (id integer PRIMARY KEY, v text);
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TABLE public.child (extra integer, PRIMARY KEY (id)) INHERITS (public.parent);
CREATE INDEX child_extra ON public.child (extra);
CREATE TRIGGER child_touch BEFORE INSERT ON public.child FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE RULE child_keep AS ON DELETE TO public.child DO INSTEAD NOTHING;
ALTER TABLE public.child ENABLE ROW LEVEL SECURITY;
CREATE POLICY child_all ON public.child USING (true);
CREATE STATISTICS public.child_stats ON id, extra FROM public.child;
CREATE TABLE public.kid_serial (n serial) INHERITS (public.parent);
CREATE TYPE public.row_t AS (a integer, b text);
CREATE TABLE public.typed OF public.row_t (PRIMARY KEY (a));
CREATE SCHEMA ext;
CREATE EXTENSION file_fdw SCHEMA ext;
CREATE SERVER files FOREIGN DATA WRAPPER file_fdw;
CREATE FOREIGN TABLE public.ext_rows (a integer) SERVER files OPTIONS (filename '/dev/null');
CREATE TRIGGER ext_touch BEFORE INSERT ON public.ext_rows FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE TABLE public.refs (id integer PRIMARY KEY, child_id integer REFERENCES public.child (id),
  parent_id integer REFERENCES public.parent (id));
CREATE FUNCTION public.add2(a integer, b integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE
  AS $$ BEGIN RETURN a + b; END $$;
CREATE AGGREGATE public.sum2(integer) (SFUNC = public.add2, STYPE = integer);
INSERT INTO public.parent VALUES (1, 'one'), (2, 'two');
INSERT INTO public.child VALUES (10, 'ten', 7);
INSERT INTO public.kid_serial (id, v) VALUES (20, 'twenty');
INSERT INTO public.typed VALUES (1, 'typed');
INSERT INTO public.refs VALUES (1, 10, 1);
`

async function run(database: string, sql: string | string[]): Promise<void> {
  const client = new pg.Client({ connectionString: postgresUrlAt(url, database) })
  await client.connect()
  try {
    for (const statement of Array.isArray(sql) ? sql : [sql]) await client.query(statement)
  } finally {
    await client.end()
  }
}

async function one<T>(database: string, sql: string): Promise<T> {
  const client = new pg.Client({ connectionString: postgresUrlAt(url, database) })
  await client.connect()
  try {
    return (await client.query(sql)).rows[0] as T
  } finally {
    await client.end()
  }
}

async function backup(driver: Driver): Promise<string> {
  const session = await driver.session!('snapshot')
  try {
    const server = await prepare(session)
    let text = ''
    for await (const piece of backupSql(session, server, ['public'], WHEN)) text += piece
    return text
  } finally {
    await session.end(false)
  }
}

async function restore(driver: Driver, file: string) {
  const session = await driver.session!('write')
  try {
    const result = await restoreSql(
      session,
      (async function* () {
        yield new TextEncoder().encode(file)
      })(),
      { check: async (header) => refuseBlocked(header, await restorePlan(session, header)) },
    )
    await session.end(true)
    return result
  } catch (error) {
    await session.end(false)
    throw error
  }
}

describe('a backup beside what it can’t hold', () => {
  let admin: Driver
  let source: Driver
  let target: Driver
  let empty: Driver
  let file: string

  beforeAll(async () => {
    admin = postgresDriver(url)
    await run(
      'postgres',
      [SOURCE, TARGET, EMPTY].flatMap((name) => [
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
        `CREATE DATABASE ${name}`,
      ]),
    )
    await run(SOURCE, FIXTURE)
    await run(TARGET, FIXTURE)
    source = admin.withDatabase!(SOURCE)
    target = admin.withDatabase!(TARGET)
    empty = admin.withDatabase!(EMPTY)
  }, 60_000)

  afterAll(async () => {
    await Promise.all([source?.close(), target?.close(), empty?.close()])
    await run(
      'postgres',
      [SOURCE, TARGET, EMPTY].map((name) => `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
    ).catch(() => {})
    await admin?.close()
  })

  it('is made whole, without them or anything of theirs, and says what it left out', async () => {
    file = await backup(source)
    const header = readHeader(file.slice(0, file.indexOf('\n')))
    expect(header.notIncluded).toEqual([
      'server files',
      'constraint refs_child_id_fkey on table public.refs (it refers to public.child, which a backup can’t hold)',
      'foreign table public.ext_rows',
      'function public.sum2(integer)',
      'table public.child',
      'table public.kid_serial',
      'table public.typed',
    ])
    expect(file.trimEnd().split('\n').pop()).toBe('-- otw-db backup complete {"tables":2,"rows":3}')
    // No statement names them: not their keys, indexes, triggers, rules, policies or sequences.
    const statements = file
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(
      /"child"|child_(extra|touch|keep|all|stats)|kid_serial|"typed"|ext_rows|ext_touch|sum2/,
    )
  })

  it('restores into an empty database: the tables it holds, their rows and the keys between them', async () => {
    await restore(empty, file)
    expect(
      await one(
        EMPTY,
        `SELECT (SELECT count(*)::int FROM public.parent) AS parents,
                (SELECT count(*)::int FROM public.refs) AS refs,
                (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
                  WHERE conrelid = 'public.refs'::regclass) AS keys`,
      ),
    ).toEqual({ parents: 2, refs: 1, keys: 'refs_parent_id_fkey,refs_pkey' })
  })

  it('refuses a restore that would drop what it can’t hold, and says what', async () => {
    const session = await target.session!('snapshot')
    const plan = await restorePlan(session, readHeader(file.slice(0, file.indexOf('\n'))))
    await session.end(false)
    expect(plan.blocked).toEqual([
      'constraint refs_child_id_fkey on table public.refs needs table public.child, which the backup can’t hold',
      'function public.sum2(integer) needs function public.add2(integer,integer)',
      'table public.child needs table public.parent',
      'table public.kid_serial needs table public.parent',
      'table public.typed needs type public.row_t',
      'trigger child_touch on table public.child needs function public.touch()',
      'trigger ext_touch on foreign table public.ext_rows needs function public.touch()',
    ])
    await expect(restore(target, file)).rejects.toThrow(
      /^Restoring would also drop what the backup can't hold, or what's outside its schemas \(public\):\nconstraint refs_child_id_fkey on table public\.refs needs table public\.child, which the backup can’t hold\n[^]*\nBack up those schemas too, or remove what's listed here, then restore\.$/,
    )
    // Nothing went: not the rows of the table that inherits, nor the foreign table.
    expect(
      await one(
        TARGET,
        `SELECT (SELECT count(*)::int FROM ONLY public.child) AS child,
                to_regclass('public.ext_rows') IS NOT NULL AS foreign_table,
                to_regprocedure('public.sum2(integer)') IS NOT NULL AS aggregate`,
      ),
    ).toEqual({ child: 1, foreign_table: true, aggregate: true })
  })

  it('leaves alone what needs nothing it replaces: a foreign table, an aggregate', async () => {
    // What stood in the way, removed by hand as the refusal says; the foreign table, and an
    // aggregate on a built-in function, need nothing the restore replaces.
    await run(TARGET, [
      'DROP TABLE public.refs, public.child, public.kid_serial, public.typed',
      'DROP AGGREGATE public.sum2(integer)',
      'DROP TRIGGER ext_touch ON public.ext_rows',
      'CREATE AGGREGATE public.total(integer) (SFUNC = int4pl, STYPE = integer)',
      `UPDATE public.parent SET v = 'changed'`,
    ])
    await restore(target, file)
    expect(
      await one(
        TARGET,
        `SELECT (SELECT string_agg(v, ',' ORDER BY id) FROM public.parent) AS parents,
                to_regclass('public.ext_rows') IS NOT NULL AS foreign_table,
                (SELECT count(*)::int FROM public.ext_rows) AS foreign_rows,
                to_regprocedure('public.total(integer)') IS NOT NULL AS aggregate`,
      ),
    ).toEqual({ parents: 'one,two', foreign_table: true, foreign_rows: 0, aggregate: true })
  })

  it('refuses to drop an extension in its schemas that something outside them is built on', async () => {
    // A restore drops the schema's extensions and makes them again: what's built on one, a
    // server on its foreign-data wrapper, would go with it and not come back.
    await run(TARGET, [
      'CREATE EXTENSION postgres_fdw SCHEMA public',
      'CREATE SERVER elsewhere FOREIGN DATA WRAPPER postgres_fdw',
    ])
    const session = await target.session!('snapshot')
    const plan = await restorePlan(session, readHeader(file.slice(0, file.indexOf('\n'))))
    await session.end(false)
    expect(plan.blocked).toEqual(['server elsewhere needs foreign-data wrapper postgres_fdw'])
    await expect(restore(target, file)).rejects.toThrow('server elsewhere needs')
    expect(
      await one(
        TARGET,
        `SELECT count(*)::int AS n FROM pg_foreign_server WHERE srvname = 'elsewhere'`,
      ),
    ).toEqual({ n: 1 })
  })
})

describe('a restore beside tables it leaves where they are', () => {
  /*
   * A table that inherits one outside the schemas, a partition of one outside them and a foreign
   * table aren't in a backup, and a restore says it leaves them alone: with their privileges,
   * which the backup doesn't hold and so couldn't put back, and with the sequences they own.
   */
  const DATABASE = 'otw_db_kept_grants'
  const ROLE = 'otw_db_kept_reader'
  let admin: Driver
  let database: Driver

  beforeAll(async () => {
    admin = postgresDriver(url)
    await run('postgres', [
      `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`,
      `DROP ROLE IF EXISTS ${ROLE}`,
      `CREATE ROLE ${ROLE}`,
      `CREATE DATABASE ${DATABASE}`,
    ])
    await run(
      DATABASE,
      `CREATE SCHEMA other;
       CREATE TABLE other.base (id integer PRIMARY KEY, v text);
       CREATE TABLE public.kid () INHERITS (other.base);
       CREATE TABLE other.events (id integer, at date) PARTITION BY RANGE (at);
       CREATE TABLE public.events_2026 PARTITION OF other.events
         FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
       CREATE SEQUENCE public.events_2026_n OWNED BY public.events_2026.id;
       ALTER TABLE public.events_2026 ALTER COLUMN id SET DEFAULT nextval('public.events_2026_n');
       CREATE EXTENSION file_fdw SCHEMA other;
       CREATE SERVER kept_files FOREIGN DATA WRAPPER file_fdw;
       CREATE FOREIGN TABLE public.ext_rows (a integer) SERVER kept_files OPTIONS (filename '/dev/null');
       CREATE TABLE public.plain (id integer PRIMARY KEY);
       GRANT SELECT ON public.kid, public.events_2026, public.ext_rows, public.plain TO ${ROLE};
       GRANT USAGE ON SEQUENCE public.events_2026_n TO ${ROLE};
       INSERT INTO public.events_2026 (at) VALUES ('2026-06-01');`,
    )
    database = admin.withDatabase!(DATABASE)
  }, 60_000)

  afterAll(async () => {
    await database?.close()
    await run('postgres', [
      `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`,
      `DROP ROLE IF EXISTS ${ROLE}`,
    ]).catch(() => {})
    await admin?.close()
  })

  it('keeps their privileges, and the sequence a partition of a table outside owns', async () => {
    await restore(database, await backup(database))
    expect(
      await one(
        DATABASE,
        `SELECT has_table_privilege('${ROLE}', 'public.kid', 'SELECT') AS inherits,
                has_table_privilege('${ROLE}', 'public.events_2026', 'SELECT') AS partition,
                has_table_privilege('${ROLE}', 'public.ext_rows', 'SELECT') AS foreign_table,
                has_table_privilege('${ROLE}', 'public.plain', 'SELECT') AS restored,
                to_regclass('public.events_2026_n') IS NOT NULL AS sequence,
                (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                  WHERE d.adrelid = to_regclass('public.events_2026')) AS id_default,
                CASE WHEN to_regclass('public.events_2026_n') IS NULL THEN false
                     ELSE has_sequence_privilege('${ROLE}', 'public.events_2026_n', 'USAGE') END AS sequence_use`,
      ),
    ).toEqual({
      inherits: true,
      partition: true,
      foreign_table: true,
      restored: true,
      sequence: true,
      id_default: `nextval('events_2026_n'::regclass)`,
      sequence_use: true,
    })
  })
})
