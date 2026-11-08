import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
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
import {
  createDbAdmin,
  pgliteDriver,
  postgresDriver,
  type AuditEvent,
  type DbAdmin,
  type Driver,
} from '../src/index.ts'
import { CHUNK_BYTES } from '../src/backup/staging.ts'

const SITE = { name: 'site', url: 'postgres://embedded.site/', access: 'write' as const }
const VIEWER = { name: 'viewer', url: 'postgres://embedded.site/', access: 'read' as const }

function request(
  path: string,
  init: { body?: unknown; bytes?: Uint8Array; who?: string } = {},
): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.who ?? 'ana'}`,
    'x-db-admin': '1',
    host: 'example.com',
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.bytes) headers['content-type'] = 'application/octet-stream'
  return new Request(`http://example.com/db/api${path}`, {
    method: init.body === undefined && !init.bytes ? 'GET' : 'POST',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.bytes ? { body: init.bytes as BodyInit } : {}),
  })
}

/** The restore's lines of JSON, as the browser reads them. */
async function lines(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Uploads `file` in pieces of `size` bytes and runs the restore. */
async function restore(
  admin: DbAdmin,
  connection: string,
  file: Uint8Array,
  { size = CHUNK_BYTES, kind = 'sql' }: { size?: number; kind?: string } = {},
) {
  const started = await admin.fetch(
    request('/restore-start', { body: { connection, size: file.length, kind, name: 'b' } }),
  )
  expect(started.status).toBe(200)
  const { upload } = (await started.json()) as { upload: string }
  for (let seq = 0; seq * size < file.length; seq += 1) {
    const piece = await admin.fetch(
      request(`/restore-chunk?connection=${connection}&upload=${upload}&seq=${seq}`, {
        bytes: file.subarray(seq * size, (seq + 1) * size),
      }),
    )
    expect(piece.status).toBe(200)
  }
  const ran = await admin.fetch(request('/restore-run', { body: { connection, upload } }))
  expect(ran.status).toBe(200)
  expect(ran.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
  return { upload, lines: await lines(ran) }
}

describe('the backup API, on the site’s embedded database', () => {
  let db: PGlite
  let admin: DbAdmin
  const audit = vi.fn<(event: AuditEvent) => void>()

  beforeAll(async () => {
    db = new PGlite()
  })
  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.exec(`DROP TABLE IF EXISTS public.notes;
      CREATE TABLE public.notes (id integer PRIMARY KEY, body text);
      INSERT INTO public.notes VALUES (1, 'kept'), (2, 'also kept');`)
    audit.mockClear()
    admin = createDbAdmin({
      basePath: '/db',
      connections: [SITE, VIEWER],
      authorize: (r) => {
        const who = r.headers.get('authorization')?.replace('Bearer ', '')
        return who === 'ana' || who === 'bo' ? { id: who } : null
      },
      driver: () => pgliteDriver(db),
      audit,
      ui: false,
    })
  })
  afterEach(async () => {
    await admin.close()
  })

  const notes = async () =>
    (await db.query<{ id: number; body: string }>('SELECT * FROM public.notes ORDER BY id')).rows

  it('says a connection can be backed up', async () => {
    const { connections } = (await (await admin.fetch(request('/connections'))).json()) as {
      connections: { name: string; capabilities: { backup: boolean } }[]
    }
    expect(connections.map((c) => [c.name, c.capabilities.backup])).toEqual([
      ['site', true],
      ['viewer', true],
    ])
  })

  it('offers the schemas, says the site waits, and that pg_dump can’t reach it', async () => {
    const response = await admin.fetch(request('/backup-options?connection=site'))
    expect(response.status).toBe(200)
    const options = await response.json()
    expect(options).toMatchObject({
      database: 'postgres',
      exclusive: true,
      notIncluded: [],
      pgDump: { available: false, reason: expect.stringContaining('runs inside the site') },
      restore: { allowed: true, chunkBytes: CHUNK_BYTES, maxBytes: 1_073_741_824 },
    })
    expect(options.schemas).toEqual([expect.objectContaining({ name: 'public', selected: true })])
    const viewer = await (await admin.fetch(request('/backup-options?connection=viewer'))).json()
    expect(viewer.restore.allowed).toBe(false)
  })

  it('downloads a gzipped backup, named for the connection, the database and the time', async () => {
    const response = await admin.fetch(
      request('/backup', { body: { connection: 'site', schemas: ['public'], format: 'sql' } }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="site-postgres-\d{4}-\d{2}-\d{2}-\d{4}\.sql\.gz"$/,
    )
    const sql = gunzipSync(Buffer.from(await response.arrayBuffer())).toString()
    expect(sql.startsWith('-- otw-db backup {"format":"otw-db"')).toBe(true)
    expect(sql).toContain(
      `INSERT INTO "public"."notes" ("id", "body") VALUES\n('1', 'kept'),\n('2', 'also kept');`,
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: 'ana',
        action: 'backup',
        statement: 'backup of public as sql',
        rows: 2,
      }),
    )
  })

  it('restores an upload sent in pieces, saying how it went, and audits it', async () => {
    const file = new Uint8Array(
      await (
        await admin.fetch(
          request('/backup', { body: { connection: 'site', schemas: ['public'], format: 'sql' } }),
        )
      ).arrayBuffer(),
    )
    await db.exec(
      `DELETE FROM public.notes; INSERT INTO public.notes VALUES (9, 'after the backup')`,
    )
    const { lines: said } = await restore(admin, 'site', file, { size: 100 })
    expect(said.at(-1)).toMatchObject({ type: 'done', tables: 1, rows: 2 })
    expect(await notes()).toEqual([
      { id: 1, body: 'kept' },
      { id: 2, body: 'also kept' },
    ])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'restore',
        statement: expect.stringContaining('restore of public'),
        rows: 2,
      }),
    )
    const left = await db.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'otw_db_restore'`)
    expect(left.rows).toEqual([])
  })

  it('plans a restore: what it replaces, and that nothing stops it', async () => {
    const header = {
      format: 'otw-db',
      version: 1,
      schemas: ['public'],
      roles: [],
      serverVersion: 180000,
      server: 'PostgreSQL 18',
    }
    const response = await admin.fetch(
      request('/restore-plan', { body: { connection: 'site', header } }),
    )
    expect(await response.json()).toMatchObject({
      schemas: [{ schema: 'public', exists: true, tables: 1 }],
      blocked: [],
      missingRoles: [],
    })
  })

  it('answers a file that isn’t a backup with an error, and changes nothing', async () => {
    const { lines: said } = await restore(
      admin,
      'site',
      new TextEncoder().encode('DROP TABLE public.notes;\n'),
    )
    expect(said.at(-1)).toMatchObject({ type: 'error', error: { code: 'not-a-backup' } })
    expect(await notes()).toHaveLength(2)
  })

  it('refuses a restore on a read-only connection', async () => {
    const response = await admin.fetch(
      request('/restore-start', {
        body: { connection: 'viewer', size: 10, kind: 'sql', name: 'b' },
      }),
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.message).toBe(
      'Restoring needs write access, and connection "viewer" is read-only.',
    )
  })

  it('keeps an upload to whoever started it, refuses a piece too big, and an upload unfinished', async () => {
    const started = await admin.fetch(
      request('/restore-start', { body: { connection: 'site', size: 10, kind: 'sql', name: 'b' } }),
    )
    const { upload } = (await started.json()) as { upload: string }
    const theirs = await admin.fetch(
      request(`/restore-chunk?connection=site&upload=${upload}&seq=0`, {
        bytes: new Uint8Array(5),
        who: 'bo',
      }),
    )
    expect(theirs.status).toBe(404)
    const big = await admin.fetch(
      request(`/restore-chunk?connection=site&upload=${upload}&seq=0`, {
        bytes: new Uint8Array(CHUNK_BYTES + 1),
      }),
    )
    expect(big.status).toBe(413)
    await admin.fetch(
      request(`/restore-chunk?connection=site&upload=${upload}&seq=0`, {
        bytes: new Uint8Array(5),
      }),
    )
    const early = await admin.fetch(
      request('/restore-run', { body: { connection: 'site', upload } }),
    )
    expect(early.status).toBe(400)
    expect((await early.json()).error.message).toMatch(
      /^The upload isn't complete: 5 of 10 bytes arrived/,
    )
    const dropped = await admin.fetch(
      request('/restore-discard', { body: { connection: 'site', upload } }),
    )
    expect(await dropped.json()).toEqual({ discarded: true })
  })

  it('refuses a restore bigger than its limit before anything is sent', async () => {
    const response = await admin.fetch(
      request('/restore-start', {
        body: { connection: 'site', size: 2 * 1_073_741_824, kind: 'sql', name: 'b' },
      }),
    )
    expect(response.status).toBe(413)
  })
})

/** pg_dump and pg_restore as new as the test server, or none (CI's runner has 16). */
const tools = (() => {
  try {
    const major = Number(
      /\)\s+(\d+)/.exec(execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }))?.[1],
    )
    return major >= 17
  } catch {
    return false
  }
})()

describe.skipIf(!tools)('the backup API, with pg_dump on the server', () => {
  const url = inject('postgresUrl')
  let driver: Driver
  let admin: DbAdmin

  beforeAll(async () => {
    driver = postgresDriver(url)
    admin = createDbAdmin({
      basePath: '/db',
      connections: [{ name: 'main', url, access: 'write' }],
      authorize: () => ({ id: 'ana' }),
      driver: () => driver,
      audit: false,
      ui: false,
    })
    const write = { maxRows: 10, timeoutMs: 5_000, access: 'write' as const }
    await driver.query('DROP SCHEMA IF EXISTS dumped CASCADE', write)
    await driver.query('CREATE SCHEMA dumped', write)
    await driver.query('CREATE TABLE dumped.notes (id integer PRIMARY KEY, body text)', write)
    await driver.query(`INSERT INTO dumped.notes VALUES (1, 'kept')`, write)
  })
  afterAll(async () => {
    await driver.query('DROP SCHEMA IF EXISTS dumped CASCADE', {
      maxRows: 10,
      timeoutMs: 5_000,
      access: 'write',
    })
    await admin.close()
    await driver.close()
  })

  it('downloads pg_dump’s archive and restores it with pg_restore', async () => {
    const options = await (await admin.fetch(request('/backup-options?connection=main'))).json()
    expect(options.pgDump.available).toBe(true)
    const response = await admin.fetch(
      request('/backup', { body: { connection: 'main', schemas: ['dumped'], format: 'pg_dump' } }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(/\.dump"$/)
    const archive = new Uint8Array(await response.arrayBuffer())
    expect(new TextDecoder().decode(archive.subarray(0, 5))).toBe('PGDMP')
    const write = { maxRows: 10, timeoutMs: 5_000, access: 'write' as const }
    await driver.query(`UPDATE dumped.notes SET body = 'changed'`, write)
    const { lines: said } = await restore(admin, 'main', archive, { kind: 'pg_dump' })
    expect(said.at(-1)).toMatchObject({ type: 'done' })
    const { rows } = await driver.query('SELECT body FROM dumped.notes', {
      ...write,
      access: 'read',
    })
    expect(rows).toEqual([['kept']])
  })

  it('says why pg_dump failed, rather than sending a broken file', async () => {
    const response = await admin.fetch(
      request('/backup', {
        body: { connection: 'main', schemas: ['no_such_schema'], format: 'pg_dump' },
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toBe(
      'There\'s no schema "no_such_schema" to back up.',
    )
  })
})
