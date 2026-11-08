import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { backupSql, notIncluded, prepare, schemaChoices } from '../src/backup/dump.ts'
import { readHeader, STAGING_SCHEMA } from '../src/backup/format.ts'
import { libpqTarget, schemaPattern } from '../src/backup/pg-tools.ts'
import { refuseBlocked, restorePlan, restoreSql } from '../src/backup/restore.ts'
import * as staging from '../src/backup/staging.ts'
import { postgresUrlAt } from '../src/drivers/postgres.ts'
import { pgliteDriver, postgresDriver, quotePostgres as quote, type Driver } from '../src/index.ts'

const url = inject('postgresUrl')
const ODD = 'odd "schema"'
const ROLE = 'otw_db_backup_role'
const GONE = 'otw_db_backup_gone'
const SOURCE = 'otw_db_backup_source'
const TARGET = 'otw_db_backup_target'
const WHEN = new Date('2026-11-08T12:00:00Z')

/** Every kind of object the backup says it holds, and values that are hard to write back. */
function fixture({ extensions }: { extensions: boolean }): string {
  const odd = quote(ODD)
  return `
${extensions ? EXTENSIONS : ''}
CREATE SCHEMA ${odd};
COMMENT ON SCHEMA ${odd} IS 'The odd one';
GRANT USAGE ON SCHEMA ${odd} TO ${ROLE};
CREATE TYPE public.mood AS ENUM ('sad', 'ok', 'happy', 'it''s fine');
CREATE TYPE public.pair AS (a integer, b text COLLATE "C");
COMMENT ON TYPE public.pair IS 'Two things';
CREATE DOMAIN public.positive AS integer DEFAULT 1 NOT NULL CONSTRAINT positive_check CHECK (VALUE > 0);
CREATE FUNCTION public.float_diff(a float8, b float8) RETURNS float8 LANGUAGE sql IMMUTABLE AS 'SELECT a - b';
CREATE TYPE public.floatrange AS RANGE (SUBTYPE = float8, SUBTYPE_DIFF = public.float_diff);
CREATE SEQUENCE public.codes START 100 INCREMENT 5;
CREATE FUNCTION public.next_code() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN 'C-' || nextval('public.codes')::text; END $$;
REVOKE EXECUTE ON FUNCTION public.next_code() FROM PUBLIC;
CREATE TABLE public.people (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email ${extensions ? 'citext' : 'text'} UNIQUE,
  mood public.mood DEFAULT 'ok',
  score public.positive,
  code text DEFAULT public.next_code(),
  tags text[],
  profile jsonb,
  pair public.pair,
  span public.floatrange,
  born date,
  seen timestamptz,
  wait interval,
  amount numeric(30, 10),
  ratio float8,
  photo bytea,
  addr inet,
  token uuid DEFAULT gen_random_uuid(),
  place point,
  shout text GENERATED ALWAYS AS (upper(name)) STORED,
  CONSTRAINT people_name_check CHECK (length(name) > 0)
);
COMMENT ON TABLE public.people IS 'Everyone';
COMMENT ON COLUMN public.people.name IS 'What they''re called';
${extensions ? 'CREATE INDEX people_name_trgm ON public.people USING gin (name gin_trgm_ops);' : ''}
CREATE INDEX people_lower ON public.people (lower(name)) WHERE born IS NOT NULL;
COMMENT ON INDEX public.people_lower IS 'For search';
ALTER TABLE public.people CLUSTER ON people_pkey;
CREATE TABLE public."we;ird ""name""" (
  id bigserial PRIMARY KEY,
  person integer REFERENCES public.people (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  note text
);
CREATE TABLE public.tree (id integer PRIMARY KEY, parent integer REFERENCES public.tree (id));
CREATE UNLOGGED TABLE public.cache (k text PRIMARY KEY, v text) WITH (fillfactor = 70);
ALTER TABLE public.cache REPLICA IDENTITY FULL;
CREATE RULE cache_keep AS ON DELETE TO public.cache DO INSTEAD NOTHING;
CREATE TABLE public.events (id integer NOT NULL, at date NOT NULL, what text, PRIMARY KEY (id, at))
  PARTITION BY RANGE (at);
CREATE TABLE public.events_2025 PARTITION OF public.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE public.events_other PARTITION OF public.events DEFAULT;
CREATE INDEX events_what ON public.events (what);
CREATE TABLE public.event_refs (event_id integer, event_at date,
  FOREIGN KEY (event_id, event_at) REFERENCES public.events (id, at));
CREATE TABLE public.bookings (room integer, during tstzrange, EXCLUDE USING gist (during WITH &&));
CREATE TABLE public.only_generated (a integer GENERATED ALWAYS AS (1) STORED);
CREATE TABLE public.audit (id serial PRIMARY KEY, row_id integer, at timestamptz DEFAULT now());
GRANT SELECT (row_id) ON public.audit TO ${ROLE};
CREATE FUNCTION public.log_change() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  INSERT INTO public.audit (row_id) VALUES (NEW.id);
  RETURN NEW;
END
$body$;
CREATE TRIGGER people_log AFTER INSERT ON public.people FOR EACH ROW EXECUTE FUNCTION public.log_change();
CREATE TRIGGER people_off BEFORE UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.log_change();
ALTER TABLE public.people DISABLE TRIGGER people_off;
COMMENT ON TRIGGER people_log ON public.people IS 'Logs';
CREATE FUNCTION public.people_count() RETURNS bigint LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT count(*) FROM public.people; END;
CREATE PROCEDURE public.touch(p integer) LANGUAGE sql AS $$ UPDATE public.people SET name = name WHERE id = p $$;
CREATE VIEW public.happy AS SELECT id, name FROM public.people WHERE mood = 'happy';
CREATE VIEW public.happy_names WITH (security_barrier = true) AS SELECT name FROM public.happy
  WITH CASCADED CHECK OPTION;
CREATE MATERIALIZED VIEW public.mood_counts AS SELECT mood, count(*) AS n FROM public.people GROUP BY mood;
CREATE UNIQUE INDEX mood_counts_mood ON public.mood_counts (mood);
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY people_mine ON public.people FOR SELECT TO ${ROLE} USING (name = current_user);
CREATE POLICY people_all ON public.people AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (score > 0);
COMMENT ON POLICY people_mine ON public.people IS 'Their own';
CREATE STATISTICS public.people_stats (dependencies) ON born, mood FROM public.people;
GRANT SELECT, INSERT ON public.people TO ${ROLE};
GRANT SELECT ON public.people TO ${GONE};
CREATE TABLE ${odd}.things (id integer PRIMARY KEY, person integer REFERENCES public.people (id), mood public.mood);
CREATE SEQUENCE ${odd}.counter OWNED BY ${odd}.things.id;
ALTER TABLE ${odd}.things OWNER TO ${ROLE};

INSERT INTO public.people (name, email, mood, score, tags, profile, pair, span, born, seen, wait, amount, ratio, photo, addr, place) VALUES
  ('Ada', 'ADA@x.org', 'happy', 3, '{a,"b c","d\\"e"}', '{"k": [1, "two", null]}', '(1,x)', '[1.5,2)', '1815-12-10',
   '2026-11-08 10:00:00+05', '1 day 02:03:04', 12345678901234567890.0123456789, 0.1, '\\x00ff10', '192.168.0.1/24', '(1.5,2)'),
  ('Grace; Hopper', NULL, 'it''s fine', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Infinity', NULL, NULL, NULL),
  (E'Line\\nbreak \\\\ back''slash', 'x@y', NULL, 2, '{}', '[]', '(,)', 'empty', NULL, '-infinity', '-1 year', -0.5, 'NaN', '\\x', '::1', NULL),
  ('ünïcødé 漢字 🎉', NULL, 'sad', 5, NULL, '"str"', NULL, NULL, '2000-02-29', NULL, NULL, 0, -1.5e300, NULL, NULL, NULL);
INSERT INTO public."we;ird ""name""" (person, note) VALUES (1, 'semi;colon'), (2, '$$dollar$$ and $tag$ -- not a comment /*');
INSERT INTO public.tree VALUES (1, NULL), (2, 1), (3, 2);
INSERT INTO public.cache VALUES ('k', 'v');
INSERT INTO public.events VALUES (1, '2025-05-01', 'a'), (2, '2026-05-01', 'b'), (3, '2030-01-01', 'c');
INSERT INTO public.event_refs VALUES (1, '2025-05-01');
INSERT INTO public.bookings VALUES (1, '[2026-01-01,2026-01-02)');
INSERT INTO public.only_generated DEFAULT VALUES;
INSERT INTO public.only_generated DEFAULT VALUES;
INSERT INTO ${odd}.things VALUES (1, 1, 'ok');
SELECT nextval('public.codes');
SELECT setval('${quote(ODD).replaceAll("'", "''")}.counter', 42);
REFRESH MATERIALIZED VIEW public.mood_counts;
`
}

/**
 * Run after the fixture's transaction: a NOT VALID check the rows break, which a restore must add
 * after them. (In the same transaction, the deferred foreign key's pending checks would stop it.)
 */
const NOT_VALID = `ALTER TABLE public."we;ird ""name""" ADD CONSTRAINT note_short CHECK (length(note) < 5) NOT VALID`

/**
 * Extensions in the schemas, and one outside them that only a function's body uses, through a
 * check: PostgreSQL records no dependency on it, so the backup makes the database's others too.
 */
const EXTENSIONS = `CREATE EXTENSION citext; CREATE EXTENSION pg_trgm;
CREATE SCHEMA ext; CREATE EXTENSION "uuid-ossp" SCHEMA ext;
CREATE FUNCTION public.item_uuid(k text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $$ SELECT ext.uuid_generate_v5(ext.uuid_ns_url(), k) $$;
CREATE TABLE public.items (id uuid PRIMARY KEY, key text NOT NULL, CHECK (id = public.item_uuid(key)));
INSERT INTO public.items VALUES (public.item_uuid('a'), 'a');`

/** The tables to compare, row for row. */
const TABLES = [
  'public.items',
  'public.people',
  'public."we;ird ""name"""',
  'public.tree',
  'public.cache',
  'public.events_2025',
  'public.events_2026',
  'public.events_other',
  'public.event_refs',
  'public.bookings',
  'public.only_generated',
  'public.audit',
  'public.mood_counts',
  `${quote(ODD)}.things`,
]

async function backup(driver: Driver, schemas: string[]): Promise<string> {
  const session = await driver.session!('snapshot')
  try {
    const server = await prepare(session)
    let text = ''
    for await (const piece of backupSql(session, server, schemas, WHEN)) text += piece
    return text
  } finally {
    await session.end(false)
  }
}

/** Restores `file` in pieces of `size` bytes, as uploads arrive. */
async function restore(driver: Driver, file: string | Uint8Array, size = 65_536) {
  const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file
  const session = await driver.session!('write')
  try {
    const result = await restoreSql(
      session,
      (async function* () {
        for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
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

/** Each table's rows, as a count and a hash of them in order. */
async function rows(driver: Driver, tables = TABLES): Promise<Record<string, string>> {
  const session = await driver.session!('snapshot')
  try {
    const out: Record<string, string> = {}
    for (const table of tables) {
      const { rows } = await session.query(
        `SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) FROM ONLY ${table} t`,
      )
      out[table] = rows[0]![0]!
    }
    const { rows: sequences } = await session.query(
      `SELECT string_agg(schemaname || '.' || sequencename || '=' || coalesce(last_value::text, '-'), ' ' ORDER BY schemaname, sequencename)
         FROM pg_sequences WHERE schemaname IN ('public', $1)`,
      [ODD],
    )
    out.sequences = sequences[0]![0] ?? ''
    return out
  } finally {
    await session.end(false)
  }
}

/** pg_dump's schema of `database`, without what changes between runs. */
function schemaOf(database: string, schemas: string[]): string {
  const { url: target, env } = libpqTarget(postgresUrlAt(url, database))
  const args = [
    '--schema-only',
    ...schemas.map((s) => `--schema=${schemaPattern(s)}`),
    `--dbname=${target}`,
  ]
  const out = pgDump(args, env)
  return out
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line) && !line.startsWith('-- Dumped'))
    .join('\n')
}

/** pg_dump of the server's major version: this machine's, or one in Docker (CI's runner has 16). */
function pgDump(args: string[], env: Record<string, string>): string {
  const local = (() => {
    try {
      return Number(
        /\)\s+(\d+)/.exec(execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }))?.[1],
      )
    } catch {
      return 0
    }
  })()
  if (local >= 17) {
    return execFileSync('pg_dump', args, { encoding: 'utf8', env: { ...process.env, ...env } })
  }
  return execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'postgres:17-alpine',
      'pg_dump',
      ...args,
    ],
    { encoding: 'utf8' },
  )
}

/** Runs `sql` in `database`; a list runs a statement at a time (DROP DATABASE must be alone). */
async function run(database: string, sql: string | string[]): Promise<void> {
  const client = new pg.Client({ connectionString: postgresUrlAt(url, database) })
  await client.connect()
  try {
    for (const statement of Array.isArray(sql) ? sql : [sql]) await client.query(statement)
  } finally {
    await client.end()
  }
}

describe('a PostgreSQL backup', () => {
  let admin: Driver
  let source: Driver
  let target: Driver
  let file: string

  beforeAll(async () => {
    admin = postgresDriver(url)
    await run('postgres', [
      `DROP DATABASE IF EXISTS ${SOURCE} WITH (FORCE)`,
      `DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)`,
      `CREATE DATABASE ${SOURCE}`,
      `CREATE DATABASE ${TARGET}`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE}; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GONE}') THEN CREATE ROLE ${GONE}; END IF;
      END $$`,
    ])
    await run(SOURCE, [fixture({ extensions: true }), NOT_VALID])
    source = admin.withDatabase!(SOURCE)
    target = admin.withDatabase!(TARGET)
    file = await backup(source, ['public', ODD])
    // A role the backup names, gone before the restore: what it was granted is skipped.
    await run(SOURCE, `REVOKE ALL ON public.people FROM ${GONE}`)
    await run('postgres', `DROP ROLE ${GONE}`)
  }, 60_000)

  afterAll(async () => {
    await Promise.all([source?.close(), target?.close()])
    await run('postgres', [
      `DROP DATABASE IF EXISTS ${SOURCE} WITH (FORCE)`,
      `DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)`,
      `DROP ROLE IF EXISTS ${GONE}`,
    ]).catch(() => {})
    await run('postgres', `DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE}`).catch(() => {})
    await admin?.close()
  })

  it('says what it holds on its first line, and that it is whole on its last', () => {
    const header = readHeader(file.slice(0, file.indexOf('\n')))
    expect(header).toMatchObject({
      format: 'otw-db',
      version: 1,
      createdAt: WHEN.toISOString(),
      database: SOURCE,
      schemas: ['public', ODD],
      notIncluded: [],
    })
    expect(header.server).toMatch(/^PostgreSQL 17/)
    expect(header.roles).toEqual([GONE, ROLE].sort())
    expect(file.trimEnd().split('\n').pop()).toBe(
      `-- otw-db backup complete {"tables":${TABLES.length - 1},"rows":${1 + 4 + 2 + 3 + 1 + 3 + 1 + 1 + 2 + 4 + 1}}`,
    )
  })

  it('restores into an empty database the same schema, rows and sequences as pg_dump sees them', async () => {
    const result = await restore(target, file)
    expect(result.rows).toBe(23)
    expect(schemaOf(TARGET, ['public', ODD])).toBe(schemaOf(SOURCE, ['public', ODD]))
    expect(await rows(target)).toEqual(await rows(source))
  }, 60_000)

  it('restores over what changed since, back to what the backup holds', async () => {
    await run(
      TARGET,
      `
      DELETE FROM public.tree WHERE id = 3;
      INSERT INTO public.cache VALUES ('new', 'row');
      ALTER TABLE public.people ADD COLUMN extra text;
      CREATE TABLE public.added (id int);
      DROP VIEW public.happy_names;
      CREATE FUNCTION public.added() RETURNS int LANGUAGE sql AS 'SELECT 1';`,
    )
    await restore(target, gzipSync(file))
    expect(schemaOf(TARGET, ['public', ODD])).toBe(schemaOf(SOURCE, ['public', ODD]))
    expect(await rows(target)).toEqual(await rows(source))
  }, 60_000)

  it('changes nothing when a statement fails', async () => {
    const before = await rows(target)
    const broken = file.replace(
      'INSERT INTO "public"."tree"',
      'INSERT INTO "public"."no_such_table"',
    )
    await expect(restore(target, broken)).rejects.toThrow(
      /Statement [\d,]+ of the backup failed, so nothing was restored: relation "public.no_such_table" does not exist/,
    )
    expect(await rows(target)).toEqual(before)
    expect(schemaOf(TARGET, ['public', ODD])).toBe(schemaOf(SOURCE, ['public', ODD]))
  }, 60_000)

  it('refuses a file cut short, changing nothing', async () => {
    await run(TARGET, `INSERT INTO public.cache VALUES ('after', 'backup')`)
    const before = await rows(target)
    const cut = file.slice(0, file.lastIndexOf('-- otw-db backup complete'))
    await expect(restore(target, cut)).rejects.toThrow('The backup stops before its end')
    const gz = gzipSync(file)
    await expect(restore(target, gz.subarray(0, gz.length - 20))).rejects.toThrow(
      "The backup can't be read",
    )
    expect(await rows(target)).toEqual(before)
  }, 60_000)

  it('refuses to drop what another schema builds on, and says what', async () => {
    await run(
      TARGET,
      `CREATE SCHEMA reporting; CREATE VIEW reporting.names AS SELECT name FROM public.people`,
    )
    try {
      const session = await target.session!('snapshot')
      const plan = await restorePlan(session, readHeader(file.slice(0, file.indexOf('\n'))))
      await session.end(false)
      expect(plan.blocked).toEqual([
        'rule _RETURN on view reporting.names needs table public.people',
      ])
      expect(plan.missingRoles).toEqual([GONE])
      // Partitions aside: events is one table.
      expect(plan.schemas.find((s) => s.schema === 'public')).toMatchObject({
        exists: true,
        tables: 10,
      })
      await expect(restore(target, file)).rejects.toThrow(
        /Restoring would also drop what's outside the backup's schemas \(public, odd "schema"\):\nrule _RETURN on view reporting.names needs table public.people/,
      )
    } finally {
      await run(TARGET, 'DROP SCHEMA reporting CASCADE')
    }
  }, 60_000)

  it('names what it leaves out, and offers the login’s own schemas', async () => {
    await run(SOURCE, `CREATE AGGREGATE public.total(integer) (SFUNC = int4pl, STYPE = integer)`)
    const session = await source.session!('snapshot')
    try {
      await prepare(session)
      expect(await notIncluded(session, ['public'])).toEqual([
        { schema: 'public', what: 'function public.total(integer)' },
      ])
      const choices = await schemaChoices(session)
      // ext holds an extension's objects alone: it isn't ticked at first.
      expect(choices.map((s) => [s.name, s.selected])).toEqual([
        ['ext', false],
        [ODD, true],
        ['public', true],
      ])
    } finally {
      await session.end(false)
      await run(SOURCE, 'DROP AGGREGATE public.total(integer)')
    }
  })

  it('takes an upload in pieces, restores it from the database, and cleans up after', async () => {
    const gz = gzipSync(file)
    const write = async <T>(
      work: (s: Awaited<ReturnType<NonNullable<Driver['session']>>>) => Promise<T>,
    ) => {
      const session = await target.session!('write')
      try {
        const result = await work(session)
        await session.end(true)
        return result
      } catch (error) {
        await session.end(false)
        throw error
      }
    }
    const id = await write((s) =>
      staging.startUpload(s, { viewer: 'ada', kind: 'sql', size: gz.length, name: 'b.sql.gz' }),
    )
    const size = 10_000
    for (let seq = 0; seq * size < gz.length; seq += 1) {
      await write(async (s) =>
        staging.putChunk(
          s,
          await staging.findUpload(s, id, 'ada'),
          seq,
          gz.subarray(seq * size, (seq + 1) * size),
        ),
      )
    }
    // Sent again after a timeout: replaced, not added.
    await write(async (s) =>
      staging.putChunk(s, await staging.findUpload(s, id, 'ada'), 0, gz.subarray(0, size)),
    )
    await expect(write((s) => staging.findUpload(s, id, 'grace'))).rejects.toThrow(
      'That upload is gone',
    )
    await write(async (s) => {
      const upload = await staging.findUpload(s, id, 'ada')
      staging.complete(upload)
      await restoreSql(s, staging.chunks(s, upload), {
        check: async (header) => refuseBlocked(header, await restorePlan(s, header)),
      })
      await staging.discard(s, id)
    })
    expect(await rows(target)).toEqual(await rows(source))
    const session = await target.session!('snapshot')
    const left = await session.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
      STAGING_SCHEMA,
    ])
    await session.end(false)
    expect(left.rows).toEqual([])
  }, 60_000)
})

describe('a PGlite backup', () => {
  it('restores into another PGlite, and backs up again the same', async () => {
    const source = new PGlite()
    const target = new PGlite()
    try {
      await source.exec(`CREATE ROLE ${ROLE}; CREATE ROLE ${GONE};`)
      await target.exec(`CREATE ROLE ${ROLE}; CREATE ROLE ${GONE};`)
      await source.exec(fixture({ extensions: false }))
      await source.exec(NOT_VALID)
      const from = pgliteDriver(source)
      const to = pgliteDriver(target)
      const file = await backup(from, ['public', ODD])
      expect(readHeader(file.slice(0, file.indexOf('\n'))).server).toMatch(/^PostgreSQL 18/)
      await restore(to, file)
      const tables = TABLES.filter((t) => t !== 'public.items')
      expect(await rows(to, tables)).toEqual(await rows(from, tables))
      expect(await backup(to, ['public', ODD])).toBe(
        file.replace(/"database":"[^"]*"/, '"database":"postgres"'),
      )
      // The host's own queries go on afterwards on the connection the restore used.
      expect((await target.query('SELECT count(*)::int AS n FROM public.people')).rows).toEqual([
        { n: 4 },
      ])
    } finally {
      await Promise.all([source.close(), target.close()])
    }
  }, 60_000)
})
