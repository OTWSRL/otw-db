import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDbAdmin,
  QueryError,
  type AuditEvent,
  type ConnectionConfig,
  type DbAdminOptions,
  type Driver,
  type QueryOptions,
} from '../src/index.ts'

const MAIN: ConnectionConfig = {
  name: 'main',
  url: 'postgres://main',
  access: 'write',
  tag: 'production',
}
const REPORTS: ConnectionConfig = { name: 'reports', url: 'postgres://reports', access: 'read' }

/** A driver that answers from memory and records what it was asked. */
function fakeDriver(overrides: Partial<Driver> = {}) {
  const calls: { sql: string; options: QueryOptions }[] = []
  const driver: Driver = {
    kind: 'postgres',
    capabilities: { schemas: true, transactionalDdl: true, cancel: true },
    tables: async () => [
      { schema: 'public', name: 'posts', kind: 'table', estimatedRows: 3, bytes: 8192 },
    ],
    table: async (schema, name) =>
      name === 'posts'
        ? {
            schema,
            name,
            kind: 'table',
            estimatedRows: 3,
            bytes: 8192,
            columns: [],
            primaryKey: ['id'],
            indexes: [],
            foreignKeys: [],
            checks: [],
            comment: null,
          }
        : null,
    rows: async () => ({
      columns: [{ name: 'id', type: 'integer' }],
      rows: [['1']],
      truncated: false,
      durationMs: 1,
    }),
    query: async (sql, options) => {
      calls.push({ sql, options })
      return {
        columns: [],
        rows: [],
        truncated: false,
        durationMs: 2,
        command: 'SELECT',
        affectedRows: 0,
      }
    },
    close: async () => {},
    ...overrides,
  }
  return { driver, calls }
}

const admins: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(admins.splice(0).map((a) => a.close()))
})

function setup(options: Partial<DbAdminOptions> = {}, driver = fakeDriver()) {
  const audit = vi.fn<(event: AuditEvent) => void>()
  const admin = createDbAdmin({
    basePath: '/db',
    connections: [MAIN, REPORTS],
    authorize: (request) =>
      request.headers.get('authorization') === 'Bearer ok' ? { id: 'ana' } : null,
    driver: () => driver.driver,
    audit,
    ...options,
  })
  admins.push(admin)
  return { admin, audit, calls: driver.calls }
}

function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    authorization: 'Bearer ok',
    'x-db-admin': '1',
    host: 'example.com',
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...init.headers,
  }
  return new Request(`http://example.com${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe('createDbAdmin', () => {
  it('refuses to start without authorize()', () => {
    expect(() => createDbAdmin({ connections: [] } as unknown as DbAdminOptions)).toThrow(
      'createDbAdmin() needs authorize(request)',
    )
  })

  it.each([
    [
      [{ ...MAIN, name: 'Main DB' }],
      'Connection names are lowercase letters, digits and hyphens, not "Main DB".',
    ],
    [[MAIN, MAIN], 'Two connections are named "main".'],
    [[{ ...MAIN, url: 'oracle://x' }], 'Connection "main" must start with postgres://'],
  ])('refuses bad connections', (connections, message) => {
    expect(() => createDbAdmin({ connections, authorize: () => null })).toThrow(message)
  })

  it('lists the connections a viewer may open, without their URLs', async () => {
    const { admin } = setup()
    const { status, body } = await json(await admin.fetch(call('/db/api/connections')))
    expect(status).toBe(200)
    expect(body.connections).toEqual([
      {
        name: 'main',
        label: 'main',
        tag: 'production',
        kind: 'postgres',
        access: 'write',
        capabilities: { schemas: true, transactionalDdl: true, cancel: true },
      },
      expect.objectContaining({ name: 'reports', access: 'read', tag: null }),
    ])
    expect(JSON.stringify(body)).not.toContain('postgres://')
  })

  it('lists a connection whose database has no driver yet, without capabilities', async () => {
    const admin = createDbAdmin({
      connections: [{ name: 'legacy', url: 'mysql://legacy', access: 'read' }],
      authorize: () => ({ id: 'ana' }),
      audit: false,
    })
    admins.push(admin)
    const { body } = await json(await admin.fetch(call('/api/connections')))
    expect(body.connections).toEqual([
      expect.objectContaining({ name: 'legacy', kind: 'mysql', capabilities: null }),
    ])
  })

  it('gives a viewer at most a connection’s own access, and hides what their access() refuses', async () => {
    const { admin, calls } = setup({
      authorize: () => ({
        id: 'ana',
        access: (c) => (c.name === 'main' ? 'write' : c.name === 'reports' ? 'write' : null),
      }),
    })
    await admin.fetch(call('/db/api/query', { body: { connection: 'reports', sql: 'SELECT 1' } }))
    expect(calls[0]!.options.access).toBe('read')

    const hidden = setup({
      authorize: () => ({ id: 'bo', access: (c) => (c.name === 'main' ? null : 'read') }),
    })
    const listed = await json(await hidden.admin.fetch(call('/db/api/connections')))
    expect(listed.body.connections.map((c: { name: string }) => c.name)).toEqual(['reports'])
    const refused = await json(
      await hidden.admin.fetch(
        call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1' } }),
      ),
    )
    expect(refused).toEqual({
      status: 404,
      body: { error: { code: 'unknown-connection', message: 'There\'s no connection "main".' } },
    })
  })

  describe('refuses', () => {
    it('a request without a viewer (401)', async () => {
      const { admin } = setup()
      const { status, body } = await json(
        await admin.fetch(call('/db/api/connections', { headers: { authorization: '' } })),
      )
      expect(status).toBe(401)
      expect(body.error.code).toBe('unauthorized')
    })

    it('a request without the x-db-admin header, which another site’s form can’t send (403)', async () => {
      const { admin } = setup()
      const response = await admin.fetch(
        call('/db/api/connections', { headers: { 'x-db-admin': '' } }),
      )
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe('missing-header')
    })

    it('a request from another origin, unless it’s listed (403)', async () => {
      const { admin } = setup()
      const evil = await admin.fetch(
        call('/db/api/connections', { headers: { origin: 'https://evil.example' } }),
      )
      expect(evil.status).toBe(403)
      expect((await evil.json()).error.code).toBe('cross-origin')
      const own = await admin.fetch(
        call('/db/api/connections', { headers: { origin: 'http://example.com' } }),
      )
      expect(own.status).toBe(200)
      const proxied = await admin.fetch(
        call('/db/api/connections', {
          headers: { origin: 'https://admin.example', 'x-forwarded-host': 'admin.example' },
        }),
      )
      expect(proxied.status).toBe(200)
      const listed = setup({ origins: ['https://tools.example'] })
      const allowed = await listed.admin.fetch(
        call('/db/api/connections', { headers: { origin: 'https://tools.example' } }),
      )
      expect(allowed.status).toBe(200)
    })

    it.each([
      [
        'a body that isn’t JSON',
        { 'content-type': 'text/plain' },
        'SELECT 1',
        415,
        'unsupported-media-type',
      ],
      ['broken JSON', {}, '{"connection":', 400, 'bad-request'],
      ['a JSON array', {}, '[]', 400, 'bad-request'],
      [
        'a body over 1 MB',
        {},
        JSON.stringify({ connection: 'main', sql: 'x'.repeat(1_048_577) }),
        413,
        'too-large',
      ],
    ])('%s', async (_, headers, body, status, code) => {
      const { admin } = setup()
      const response = await admin.fetch(call('/db/api/query', { body, headers }))
      expect(response.status).toBe(status)
      expect((await response.json()).error.code).toBe(code)
    })

    it.each([
      [{ connection: 'main' }, '"sql" is required.'],
      [
        { connection: 'main', sql: 'SELECT 1', maxRows: 1001 },
        '"maxRows" is a whole number from 1 to 1000.',
      ],
      [{ connection: 'main', sql: 'SELECT 1', queryId: 'a b' }, '"queryId" is up to 64 letters'],
    ])('a bad query %o', async (body, message) => {
      const { admin } = setup()
      const { status, body: answer } = await json(
        await admin.fetch(call('/db/api/query', { body })),
      )
      expect(status).toBe(400)
      expect(answer.error.message).toContain(message)
    })

    it.each([
      [
        { connection: 'main', schema: 'public', table: 'posts', limit: 0 },
        '"limit" is a whole number from 1 to 1000.',
      ],
      [
        {
          connection: 'main',
          schema: 'public',
          table: 'posts',
          order: [{ column: 'id', descending: 'yes' }],
        },
        '"descending" is true or false.',
      ],
      [
        {
          connection: 'main',
          schema: 'public',
          table: 'posts',
          order: Array(11).fill({ column: 'id' }),
        },
        '"order" is a list of up to 10 columns.',
      ],
      [{ connection: 'main', table: 'posts' }, '"schema" is required.'],
    ])('a bad page %o', async (body, message) => {
      const { admin } = setup()
      const { status, body: answer } = await json(await admin.fetch(call('/db/api/rows', { body })))
      expect(status).toBe(400)
      expect(answer.error.message).toBe(message)
    })
  })

  it('answers paths outside its base path with 404, and a known path’s other methods with 405', async () => {
    const { admin } = setup()
    expect((await admin.fetch(call('/api/connections'))).status).toBe(404)
    expect((await admin.fetch(call('/db/api/nothing'))).status).toBe(404)
    const wrong = await admin.fetch(call('/db/api/query', { method: 'GET' }))
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('POST')
  })

  it('serves JSON nobody caches', async () => {
    const { admin } = setup()
    const response = await admin.fetch(call('/db/api/connections'))
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('lists its routes flat, for routers that match fixed segments only', () => {
    const { admin } = setup()
    expect(admin.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/connections',
      'GET /api/tables',
      'GET /api/table',
      'POST /api/rows',
      'POST /api/query',
      'POST /api/cancel',
    ])
    for (const route of admin.routes) expect(route.path).not.toMatch(/[:*[]/)
  })

  it('reads tables, a table and a page of rows', async () => {
    const { admin, audit } = setup()
    const tables = await json(await admin.fetch(call('/db/api/tables?connection=main')))
    expect(tables.body.tables[0].name).toBe('posts')
    const table = await json(
      await admin.fetch(call('/db/api/table?connection=main&schema=public&name=posts')),
    )
    expect(table.body.table.primaryKey).toEqual(['id'])
    const missing = await json(
      await admin.fetch(call('/db/api/table?connection=main&schema=public&name=nope')),
    )
    expect(missing.status).toBe(404)
    const page = await json(
      await admin.fetch(
        call('/db/api/rows', { body: { connection: 'main', schema: 'public', table: 'posts' } }),
      ),
    )
    expect(page.body.rows).toEqual([['1']])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: 'ana',
        connection: 'main',
        action: 'rows',
        statement: 'public.posts',
        rows: 1,
      }),
    )
  })

  it('runs a query with the connection’s access and limits, and audits it', async () => {
    const { admin, calls, audit } = setup({ limits: { maxRows: 50, timeoutMs: 5_000 } })
    const { status, body } = await json(
      await admin.fetch(call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1' } })),
    )
    expect(status).toBe(200)
    expect(body.command).toBe('SELECT')
    expect(calls[0]).toMatchObject({
      sql: 'SELECT 1',
      options: { access: 'write', maxRows: 50, timeoutMs: 5_000 },
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: 'ana',
        connection: 'main',
        action: 'query',
        statement: 'SELECT 1',
        durationMs: 2,
      }),
    )
    expect(audit.mock.calls[0]![0].at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('answers a statement the database refused with 400 and its details, and audits the failure', async () => {
    const failing = fakeDriver({
      query: async () => {
        throw new QueryError('relation "nope" does not exist', '42P01', { position: 15 })
      },
    })
    const { admin, audit } = setup({}, failing)
    const { status, body } = await json(
      await admin.fetch(
        call('/db/api/query', { body: { connection: 'main', sql: 'SELECT * FROM nope' } }),
      ),
    )
    expect(status).toBe(400)
    expect(body.error).toEqual({
      code: 'query-failed',
      message: 'relation "nope" does not exist',
      sqlState: '42P01',
      position: 15,
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'relation "nope" does not exist' }),
    )
  })

  it('hides an unexpected error behind a 500, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = setup(
      {},
      fakeDriver({ tables: async () => Promise.reject(new Error('disk on fire')) }),
    )
    const { status, body } = await json(await admin.fetch(call('/db/api/tables?connection=main')))
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('disk on fire')
    expect(error).toHaveBeenCalledWith('otw-db: a request failed', expect.any(Error))
    error.mockRestore()
  })

  it('answers even when the audit log fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = setup({ audit: () => Promise.reject(new Error('log down')) })
    const response = await admin.fetch(
      call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1' } }),
    )
    expect(response.status).toBe(200)
    expect(error).toHaveBeenCalledWith('otw-db: the audit log failed', expect.any(Error))
    error.mockRestore()
  })

  it('logs to stdout by default', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { admin } = setup({ audit: undefined })
    await admin.fetch(call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1' } }))
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
      otwDb: { action: 'query', statement: 'SELECT 1' },
    })
    info.mockRestore()
  })

  it('cancels a running query for the viewer who started it, and no one else', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const slow = fakeDriver({
      query: (_sql, options) =>
        new Promise((_, reject) => {
          started()
          options.signal!.addEventListener('abort', () =>
            reject(new QueryError('canceled', '57014')),
          )
        }),
    })
    const { admin } = setup(
      {
        authorize: (request) => ({
          id: request.headers.get('authorization') === 'Bearer ok' ? 'ana' : 'bo',
        }),
      },
      slow,
    )
    const query = admin.fetch(
      call('/db/api/query', {
        body: { connection: 'main', sql: 'SELECT pg_sleep(9)', queryId: 'q1' },
      }),
    )
    await running
    const again = await admin.fetch(
      call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1', queryId: 'q1' } }),
    )
    expect(again.status).toBe(409)
    const other = await json(
      await admin.fetch(
        call('/db/api/cancel', {
          body: { queryId: 'q1' },
          headers: { authorization: 'Bearer other' },
        }),
      ),
    )
    expect(other.body).toEqual({ canceled: false })
    const own = await json(await admin.fetch(call('/db/api/cancel', { body: { queryId: 'q1' } })))
    expect(own.body).toEqual({ canceled: true })
    expect((await query).status).toBe(400)
    const after = await json(await admin.fetch(call('/db/api/cancel', { body: { queryId: 'q1' } })))
    expect(after.body).toEqual({ canceled: false })
  })

  it('stops a query when the browser leaves', async () => {
    let signal: AbortSignal | undefined
    const { admin } = setup(
      {},
      fakeDriver({
        query: (_sql, options) =>
          new Promise((_, reject) => {
            signal = options.signal
            options.signal!.addEventListener('abort', () =>
              reject(new QueryError('canceled', '57014')),
            )
          }),
      }),
    )
    const leaving = new AbortController()
    const request = new Request(
      call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1' } }),
      {
        signal: leaving.signal,
      },
    )
    const answer = admin.fetch(request)
    await vi.waitFor(() => expect(signal).toBeDefined())
    leaving.abort()
    await answer
    expect(signal!.aborted).toBe(true)
  })

  it('opens a connection’s driver once, and closes it with close()', async () => {
    const close = vi.fn(async () => {})
    const opened = vi.fn(() => fakeDriver({ close }).driver)
    const admin = createDbAdmin({
      connections: [MAIN],
      authorize: () => ({ id: 'ana' }),
      driver: opened,
      audit: false,
    })
    await admin.fetch(call('/api/tables?connection=main'))
    await admin.fetch(call('/api/tables?connection=main'))
    expect(opened).toHaveBeenCalledTimes(1)
    await admin.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
