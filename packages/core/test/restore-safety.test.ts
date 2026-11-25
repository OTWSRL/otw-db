import { gzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest'
import { backupSql, prepare } from '../src/backup/dump.ts'
import { refuseBlocked, restorePlan, restoreSql } from '../src/backup/restore.ts'
import {
  createDbAdmin,
  pgliteDriver,
  postgresDriver,
  type AuditEvent,
  type DbAdmin,
} from '../src/index.ts'

/*
 * What a restore must hold to when its input isn't a backup this tool wrote a moment ago: pieces
 * that stop coming, a file edited by hand, a staging schema someone else made, and a server whose
 * roles and default privileges differ from the backup's.
 */

const WHEN = new Date('2026-11-25T12:00:00Z')

async function backupOf(db: PGlite, schemas = ['public']): Promise<string> {
  const session = await pgliteDriver(db).session!('snapshot')
  try {
    const server = await prepare(session)
    let text = ''
    for await (const piece of backupSql(session, server, schemas, WHEN)) text += piece
    return text
  } finally {
    await session.end(false)
  }
}

async function restoreInto(db: PGlite, bytes: AsyncIterable<Uint8Array>) {
  const session = await pgliteDriver(db).session!('write')
  try {
    const result = await restoreSql(session, bytes, {
      check: async (header) => refuseBlocked(header, await restorePlan(session, header)),
    })
    await session.end(true)
    return result
  } catch (error) {
    await session.end(false)
    throw error
  }
}

async function* pieces(bytes: Uint8Array, size = 65_536): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
}

const encode = (text: string) => new TextEncoder().encode(text)

describe('a restore whose input goes wrong', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`CREATE TABLE public.notes (id integer PRIMARY KEY, body text);
      INSERT INTO public.notes VALUES (1, 'kept'), (2, 'also kept');`)
  })
  afterAll(async () => {
    await db.close()
  })

  const notes = async () =>
    (await db.query<{ id: number; body: string }>('SELECT * FROM public.notes ORDER BY id')).rows

  it('fails, without an error nobody catches, when a gzipped backup’s pieces stop coming', async () => {
    const gz = gzipSync(encode(await backupOf(db)))
    const stops = (async function* () {
      yield gz.subarray(0, 64)
      throw new Error('Client was closed and is not queryable')
    })()
    await expect(restoreInto(db, stops)).rejects.toThrow(
      "The backup can't be read: Client was closed and is not queryable",
    )
    expect(await notes()).toHaveLength(2)
  })

  it.each(['COMMIT', 'BEGIN', 'ROLLBACK', 'END', 'SAVEPOINT s', 'START TRANSACTION', 'ABORT'])(
    'refuses a file that holds %s, which would step out of the one transaction',
    async (statement) => {
      const file = await backupOf(db)
      const end = file.lastIndexOf('-- otw-db backup complete')
      const edited = `${file.slice(0, end)}/* by hand */ ${statement.toLowerCase()};\nDROP TABLE public.notes;\n${file.slice(end)}`
      await expect(restoreInto(db, pieces(encode(edited)))).rejects.toThrow(
        new RegExp(
          `^Statement [\\d,]+ of the backup is ${statement.split(' ')[0]}, which a backup never holds`,
        ),
      )
      expect(await notes()).toEqual([
        { id: 1, body: 'kept' },
        { id: 2, body: 'also kept' },
      ])
    },
  )

  it('refuses COPY, which a backup never holds: its rows are INSERTs', async () => {
    const file = await backupOf(db)
    const end = file.lastIndexOf('-- otw-db backup complete')
    const edited = `${file.slice(0, end)}COPY public.notes TO PROGRAM 'cat';\n${file.slice(end)}`
    await expect(restoreInto(db, pieces(encode(edited)))).rejects.toThrow(
      /of the backup is COPY, which a backup never holds/,
    )
  })

  it('still restores a function whose body holds BEGIN and COMMIT as words', async () => {
    await db.exec(`CREATE FUNCTION public.say() RETURNS text LANGUAGE plpgsql
      AS $$ BEGIN RETURN 'COMMIT; ROLLBACK;'; END $$`)
    try {
      const file = await backupOf(db)
      await db.exec(`DROP FUNCTION public.say()`)
      await restoreInto(db, pieces(encode(file)))
      expect((await db.query<{ say: string }>('SELECT public.say()')).rows).toEqual([
        { say: 'COMMIT; ROLLBACK;' },
      ])
    } finally {
      await db.exec(`DROP FUNCTION IF EXISTS public.say()`)
    }
  })
})

describe('a restore on a server that differs from the backup’s', () => {
  let source: PGlite
  let target: PGlite

  beforeEach(async () => {
    source = new PGlite()
    target = new PGlite()
    await source.exec(`CREATE ROLE app; CREATE ROLE auditor;`)
    await target.exec(`CREATE ROLE app;`)
  })
  afterEach(async () => {
    await Promise.all([source.close(), target.close()])
  })

  it('keeps a policy for the roles the server has, and skips one for none of them', async () => {
    await source.exec(`CREATE TABLE public.rows (id integer PRIMARY KEY, tenant integer);
      ALTER TABLE public.rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant ON public.rows AS RESTRICTIVE FOR ALL TO app, auditor
        USING (tenant = 1 AND 'a%b' LIKE 'a%') WITH CHECK (tenant = 1);
      CREATE POLICY readers ON public.rows FOR SELECT TO auditor, app USING (true);
      CREATE POLICY audit_only ON public.rows FOR SELECT TO auditor USING (true);
      COMMENT ON POLICY audit_only ON public.rows IS 'The auditor reads everything';
      COMMENT ON POLICY tenant ON public.rows IS 'One tenant';
      CREATE POLICY everyone ON public.rows FOR SELECT USING (id > 0);`)
    await restoreInto(target, pieces(encode(await backupOf(source))))
    const { rows } = await target.query<{
      policyname: string
      permissive: string
      roles: string
      note: string | null
    }>(
      `SELECT p.policyname, p.permissive, p.roles::text,
              obj_description(l.oid, 'pg_policy') AS note
         FROM pg_policies p JOIN pg_policy l ON l.polname = p.policyname
        WHERE p.tablename = 'rows' ORDER BY p.policyname`,
    )
    expect(rows).toEqual([
      { policyname: 'everyone', permissive: 'PERMISSIVE', roles: '{public}', note: null },
      { policyname: 'readers', permissive: 'PERMISSIVE', roles: '{app}', note: null },
      // The restriction still binds app: skipping it whole would let app read every tenant.
      { policyname: 'tenant', permissive: 'RESTRICTIVE', roles: '{app}', note: 'One tenant' },
    ])
  })

  it('gives restored objects the backup’s privileges, whatever this server’s defaults add', async () => {
    const schema = `CREATE TABLE public.secrets (id integer PRIMARY KEY, token text);
      CREATE TABLE public.shared (id serial PRIMARY KEY);
      GRANT SELECT ON public.shared TO app;
      CREATE TYPE public.mood AS ENUM ('ok');
      REVOKE USAGE ON TYPE public.mood FROM PUBLIC;
      CREATE FUNCTION public.admin_fn() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      REVOKE EXECUTE ON FUNCTION public.admin_fn() FROM PUBLIC;
      CREATE FUNCTION public.open_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1';`
    await source.exec(schema)
    // What a hosted server sets up: whatever its owner makes, an API role may use.
    await target.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON TYPES TO app;
      ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      -- What a backup can't hold stays through a restore, and so do its own privileges.
      CREATE ROLE reporter;
      CREATE AGGREGATE public.total(integer) (SFUNC = int4pl, STYPE = integer);
      REVOKE EXECUTE ON FUNCTION public.total(integer) FROM PUBLIC, app;
      GRANT EXECUTE ON FUNCTION public.total(integer) TO reporter;`)
    const kept = async () =>
      (
        await target.query(`SELECT
          has_function_privilege('reporter', 'public.total(integer)', 'EXECUTE') AS reporter,
          has_function_privilege('app', 'public.total(integer)', 'EXECUTE') AS app`)
      ).rows[0]
    expect(await kept()).toEqual({ reporter: true, app: false })
    const privileges = async (db: PGlite) =>
      (
        await db.query(`SELECT
          has_table_privilege('app', 'public.secrets', 'SELECT') AS secrets,
          has_table_privilege('app', 'public.shared', 'SELECT') AS shared_select,
          has_table_privilege('app', 'public.shared', 'DELETE') AS shared_delete,
          has_sequence_privilege('app', 'public.shared_id_seq', 'USAGE') AS sequence,
          has_type_privilege('app', 'public.mood', 'USAGE') AS mood,
          has_function_privilege('app', 'public.admin_fn()', 'EXECUTE') AS admin_fn,
          has_function_privilege('app', 'public.open_fn()', 'EXECUTE') AS open_fn`)
      ).rows[0]
    await restoreInto(target, pieces(encode(await backupOf(source))))
    expect(await kept()).toEqual({ reporter: true, app: false })
    expect(await privileges(target)).toEqual(await privileges(source))
    expect(await privileges(target)).toEqual({
      secrets: false,
      shared_select: true,
      shared_delete: false,
      sequence: false,
      mood: false,
      admin_fn: false,
      open_fn: true,
    })
  })
})

describe('the restore API, when someone else is in the database', () => {
  let db: PGlite
  let admin: DbAdmin
  const audit = vi.fn<(event: AuditEvent) => void>()
  const SITE = { name: 'site', url: 'postgres://embedded.site/', access: 'write' as const }

  function request(path: string, init: { body?: unknown; bytes?: Uint8Array } = {}): Request {
    const headers: Record<string, string> = { 'x-db-admin': '1', host: 'example.com' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.bytes) headers['content-type'] = 'application/octet-stream'
    return new Request(`http://example.com/db/api${path}`, {
      method: 'POST',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.bytes ? { body: init.bytes as BodyInit } : {}),
    })
  }

  const start = (size: number) =>
    admin.fetch(
      request('/restore-start', { body: { connection: 'site', size, kind: 'sql', name: 'b' } }),
    )
  const piece = (upload: string, seq: number, bytes: Uint8Array) =>
    admin.fetch(request(`/restore-chunk?connection=site&upload=${upload}&seq=${seq}`, { bytes }))
  const run = (upload: string, confirm?: string) =>
    admin.fetch(
      request('/restore-run', {
        body: { connection: 'site', upload, ...(confirm ? { confirm } : {}) },
      }),
    )

  beforeEach(async () => {
    db = new PGlite()
    await db.exec(`CREATE TABLE public.notes (id integer PRIMARY KEY, body text);
      INSERT INTO public.notes VALUES (1, 'kept');`)
    audit.mockClear()
    admin = createDbAdmin({
      basePath: '/db',
      connections: [SITE],
      authorize: () => ({ id: 'ana' }),
      driver: () => pgliteDriver(db),
      audit,
      ui: false,
    })
  })
  afterEach(async () => {
    await admin.close()
    await db.close()
  })

  it('refuses a staging schema another role made, which could read or swap the upload', async () => {
    await db.exec(`CREATE ROLE mallory; CREATE SCHEMA otw_db_restore AUTHORIZATION mallory;
      CREATE TABLE otw_db_restore.uploads (id uuid PRIMARY KEY, viewer text NOT NULL,
        kind text NOT NULL, size bigint NOT NULL, name text NOT NULL,
        created timestamptz NOT NULL DEFAULT now());
      ALTER TABLE otw_db_restore.uploads OWNER TO mallory;
      GRANT ALL ON SCHEMA otw_db_restore TO PUBLIC; GRANT ALL ON otw_db_restore.uploads TO PUBLIC;`)
    const started = await start(10)
    expect(started.status).toBe(409)
    expect((await started.json()).error).toEqual({
      code: 'staging-taken',
      message:
        'The schema otw_db_restore, where a restore’s upload waits, belongs to "mallory", not to this connection’s login "postgres": someone else made it. Drop it (DROP SCHEMA otw_db_restore CASCADE), then restore.',
    })
    const left = await db.query(`SELECT count(*)::int AS n FROM otw_db_restore.uploads`)
    expect(left.rows).toEqual([{ n: 0 }])
  })

  it('refuses a table another role put in the staging schema', async () => {
    const { upload } = (await (await start(10)).json()) as { upload: string }
    await db.exec(`CREATE ROLE mallory; ALTER TABLE otw_db_restore.chunks OWNER TO mallory;`)
    const sent = await piece(upload, 0, new Uint8Array(10))
    expect(sent.status).toBe(409)
    expect((await sent.json()).error.code).toBe('staging-taken')
  })

  it('refuses an upload with a piece missing in the middle, before anything runs', async () => {
    const gz = gzipSync(encode(await backupOf(db)))
    const half = Math.ceil(gz.length / 2)
    const { upload } = (await (await start(gz.length)).json()) as { upload: string }
    expect((await piece(upload, 0, gz.subarray(0, half))).status).toBe(200)
    expect((await piece(upload, 2, gz.subarray(half))).status).toBe(200)
    const ran = await run(upload, 'postgres')
    expect(ran.status).toBe(400)
    expect((await ran.json()).error).toEqual({
      code: 'incomplete-upload',
      message:
        'The upload has pieces missing: 2 arrived, the last of them number 3. Start the restore again.',
    })
  })

  it('runs only once the database’s name comes with the request', async () => {
    const file = gzipSync(encode(await backupOf(db)))
    const { upload } = (await (await start(file.length)).json()) as { upload: string }
    await piece(upload, 0, file)
    for (const confirm of [undefined, 'Postgres', 'site']) {
      const refused = await run(upload, confirm)
      expect(refused.status).toBe(400)
      expect((await refused.json()).error).toEqual({
        code: 'unconfirmed',
        message: 'To restore, send the database’s name, "postgres", as "confirm".',
      })
    }
    const ran = await run(upload, 'postgres')
    expect(ran.status).toBe(200)
    expect((await ran.text()).trim().split('\n').pop()).toContain('"type":"done"')
  })

  it('stops, changing nothing, when the browser goes away, and says so in the audit log', async () => {
    const backup = await backupOf(db)
    const end = backup.lastIndexOf('-- otw-db backup complete')
    // A statement long enough for the browser to leave while it runs.
    const slow = encode(`${backup.slice(0, end)}SELECT pg_sleep(0.6);\n${backup.slice(end)}`)
    await db.exec(`INSERT INTO public.notes VALUES (9, 'after the backup')`)
    const { upload } = (await (await start(slow.length)).json()) as { upload: string }
    await piece(upload, 0, slow)
    const ran = await run(upload, 'postgres')
    expect(ran.status).toBe(200)
    await ran.body!.cancel()
    await vi.waitFor(
      () => expect(audit.mock.calls.some(([e]) => e.action === 'restore')).toBe(true),
      { timeout: 5_000 },
    )
    const event = audit.mock.calls.map(([e]) => e).find((e) => e.action === 'restore')
    expect(event?.error).toBe(
      'The browser stopped listening before the restore was done, so it was stopped: nothing was restored.',
    )
    const rows = await db.query<{ id: number }>('SELECT id FROM public.notes ORDER BY id')
    expect(rows.rows.map((r) => r.id)).toEqual([1, 9])
  })

  it('audits a restore with how many statements it ran and the file’s SHA-256', async () => {
    const text = encode(await backupOf(db))
    const { upload } = (await (await start(text.length)).json()) as { upload: string }
    await piece(upload, 0, text)
    await (await run(upload, 'postgres')).text()
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', text)).toString('hex')
    const event = audit.mock.calls.map(([e]) => e).find((e) => e.action === 'restore')
    expect(event?.statement).toMatch(
      new RegExp(
        `^restore of public \\(sql, ${text.length} bytes, \\d+ statements, sha256 ${digest}\\)$`,
      ),
    )
  })
})

describe('a PostgreSQL session', () => {
  it('takes one statement a query, so text that holds two can’t end its transaction', async () => {
    const driver = postgresDriver(inject('postgresUrl'))
    const session = await driver.session!('write')
    try {
      await expect(session.query('SELECT 1; COMMIT')).rejects.toThrow(
        'cannot insert multiple commands into a prepared statement',
      )
    } finally {
      await session.end(false)
      await driver.close()
    }
  })
})

describe('a backup’s sequences', () => {
  it('go on from where they were: restarted, used, or never used', async () => {
    const source = new PGlite()
    const target = new PGlite()
    try {
      await source.exec(`CREATE SEQUENCE public.fresh;
        CREATE SEQUENCE public.restarted; ALTER SEQUENCE public.restarted RESTART WITH 100000;
        CREATE SEQUENCE public.used INCREMENT 5; SELECT nextval('public.used'), nextval('public.used');
        CREATE SEQUENCE public.set_back; SELECT setval('public.set_back', 42, false);
        CREATE TABLE public.numbered (id integer GENERATED BY DEFAULT AS IDENTITY, v text);
        ALTER TABLE public.numbered ALTER COLUMN id RESTART WITH 500;`)
      await restoreInto(target, pieces(encode(await backupOf(source))))
      const next = async (db: PGlite) =>
        (
          await db.query(`SELECT nextval('public.fresh')::int AS fresh,
            nextval('public.restarted')::int AS restarted, nextval('public.used')::int AS used,
            nextval('public.set_back')::int AS set_back,
            nextval(pg_get_serial_sequence('public.numbered', 'id'))::int AS numbered`)
        ).rows[0]
      const expected = { fresh: 1, restarted: 100000, used: 11, set_back: 42, numbered: 500 }
      expect(await next(target)).toEqual(expected)
      expect(await next(source)).toEqual(expected)
    } finally {
      await Promise.all([source.close(), target.close()])
    }
  })
})

describe('a restore on a busy PostgreSQL database', () => {
  const url = inject('postgresUrl')
  const BUSY = 'otw_db_busy'
  const at = (database: string) => {
    const address = new URL(url)
    address.pathname = `/${database}`
    return address.href
  }

  it('keeps the upload when a table is in use, so trying again needs no second upload', async () => {
    const root = new pg.Client({ connectionString: url })
    await root.connect()
    await root.query(`DROP DATABASE IF EXISTS ${BUSY} WITH (FORCE)`)
    await root.query(`CREATE DATABASE ${BUSY}`)
    const driver = postgresDriver(at(BUSY))
    const holder = new pg.Client({ connectionString: at(BUSY) })
    await holder.connect()
    const admin = createDbAdmin({
      basePath: '/db',
      connections: [{ name: 'main', url: at(BUSY), access: 'write' }],
      authorize: () => ({ id: 'ana' }),
      driver: () => driver,
      audit: false,
      ui: false,
    })
    const post = (path: string, init: { body?: unknown; bytes?: Uint8Array }) =>
      admin.fetch(
        new Request(`http://example.com/db/api${path}`, {
          method: 'POST',
          headers: {
            'x-db-admin': '1',
            host: 'example.com',
            'content-type': init.bytes ? 'application/octet-stream' : 'application/json',
          },
          body: (init.bytes as BodyInit | undefined) ?? JSON.stringify(init.body),
        }),
      )
    const last = async (response: Response) =>
      JSON.parse((await response.text()).trim().split('\n').pop()!) as {
        type: string
        error?: { code: string }
      }
    try {
      await holder.query(`CREATE TABLE public.notes (id integer PRIMARY KEY);
        INSERT INTO public.notes VALUES (1)`)
      const file = new Uint8Array(
        await (
          await post('/backup', {
            body: { connection: 'main', schemas: ['public'], format: 'sql' },
          })
        ).arrayBuffer(),
      )
      const { upload } = (await (
        await post('/restore-start', {
          body: { connection: 'main', size: file.length, kind: 'sql', name: 'b' },
        })
      ).json()) as { upload: string }
      await post(`/restore-chunk?connection=main&upload=${upload}&seq=0`, { bytes: file })
      // The site reads the table in a transaction it hasn't ended: the restore can't drop it.
      await holder.query('BEGIN; SELECT * FROM public.notes')
      const run = { body: { connection: 'main', upload, confirm: BUSY } }
      expect(await last(await post('/restore-run', run))).toMatchObject({
        type: 'error',
        error: { code: 'busy' },
      })
      await holder.query('COMMIT')
      const again = await post('/restore-run', run)
      expect(again.status).toBe(200)
      expect(await last(again)).toMatchObject({ type: 'done' })
      // Done with, the upload goes as after any restore.
      expect((await post('/restore-run', run)).status).toBe(404)
    } finally {
      await holder.end()
      await admin.close()
      await driver.close()
      await root.query(`DROP DATABASE IF EXISTS ${BUSY} WITH (FORCE)`)
      await root.end()
    }
  }, 60_000)
})
