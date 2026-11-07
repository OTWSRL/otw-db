import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDbAdmin,
  QueryError,
  renderIndex,
  ROUTES,
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
    count: async () => 42,
    sql: { identifier: (n) => `"${n}"`, literal: (v) => (v === null ? 'NULL' : `'${v}'`) },
    apply: async (_target, changes, options) => ({
      statements: changes.map((c) => c.type),
      applied: !options.dryRun,
    }),
    export: async function* () {
      yield { columns: [{ name: 'id' }], rows: [['1'], ['2']] }
    },
    info: async () => ({ product: 'PostgreSQL', version: '17.11', database: 'shop', user: 'ana' }),
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

const UI = {
  index:
    '<meta name="otw-db" content="%OTW_DB_CONFIG%"><script src="%OTW_DB_BASE%/assets/app-1.js"></script>',
  files: { 'app-1.js': { type: 'text/javascript; charset=utf-8', body: 'console.log("app")' } },
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
    ui: false,
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
        warning: null,
        kind: 'postgres',
        access: 'write',
        capabilities: { schemas: true, transactionalDdl: true, cancel: true, databases: false },
      },
      expect.objectContaining({ name: 'reports', access: 'read', tag: null }),
    ])
    expect(JSON.stringify(body)).not.toContain('postgres://')
  })

  it('lists a connection it can’t open, without capabilities', async () => {
    const admin = createDbAdmin({
      connections: [{ name: 'legacy', url: 'sqlite::memory:', access: 'read' }],
      authorize: () => ({ id: 'ana' }),
      audit: false,
    })
    admins.push(admin)
    const { body } = await json(await admin.fetch(call('/api/connections')))
    expect(body.connections).toEqual([
      expect.objectContaining({ name: 'legacy', kind: 'sqlite', capabilities: null }),
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

  it('lists four patterns for routers that register routes one by one, each answering in full', async () => {
    const { admin } = setup({ ui: async () => UI })
    expect(admin.routes.map(({ method, path }) => ({ method, path }))).toEqual(ROUTES)
    for (const route of admin.routes) expect(route.path).not.toMatch(/[*[]|:.*:/)
    const api = admin.routes.find((r) => r.method === 'GET' && r.path === '/api/:endpoint')!
    expect((await api.handler(call('/db/api/connections'))).status).toBe(200)
    // Without the app, its two patterns go.
    expect(setup({ ui: false }).admin.routes.map((r) => r.path)).toEqual([
      '/api/:endpoint',
      '/api/:endpoint',
    ])
  })

  it('reports the server and counts rows', async () => {
    const { admin, audit } = setup()
    const info = await json(await admin.fetch(call('/db/api/info?connection=main')))
    expect(info.body.info).toEqual({
      product: 'PostgreSQL',
      version: '17.11',
      database: 'shop',
      user: 'ana',
    })
    const counted = await json(
      await admin.fetch(
        call('/db/api/count', { body: { connection: 'main', schema: 'public', table: 'posts' } }),
      ),
    )
    expect(counted.body).toEqual({ count: 42 })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'count', statement: 'count public.posts', rows: 42 }),
    )
  })

  describe('applying changes', () => {
    const changes = [
      { type: 'insert', values: { title: 'New', body: null } },
      { type: 'update', key: { id: '1' }, values: { title: 'Changed' } },
      { type: 'delete', key: { id: '2' } },
    ]
    const body = (extra: object = {}) => ({
      connection: 'main',
      schema: 'public',
      table: 'posts',
      changes,
      ...extra,
    })

    it('applies them on a write connection, and audits it', async () => {
      const { admin, audit } = setup()
      const { status, body: answer } = await json(
        await admin.fetch(call('/db/api/apply', { body: body() })),
      )
      expect(status).toBe(200)
      expect(answer).toEqual({ statements: ['insert', 'update', 'delete'], applied: true })
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'apply',
          statement: 'insert;\nupdate;\ndelete',
          rows: 3,
        }),
      )
    })

    it('shows the statements of a dry run without applying them or auditing', async () => {
      const { admin, audit } = setup()
      const { body: answer } = await json(
        await admin.fetch(call('/db/api/apply', { body: body({ dryRun: true }) })),
      )
      expect(answer.applied).toBe(false)
      expect(audit).not.toHaveBeenCalled()
    })

    it('refuses a read-only connection', async () => {
      const { admin } = setup()
      const { status, body: answer } = await json(
        await admin.fetch(call('/db/api/apply', { body: body({ connection: 'reports' }) })),
      )
      expect(status).toBe(403)
      expect(answer.error.code).toBe('read-only')
    })

    it.each([
      [[], '"changes" is a list of 1 to 1000 changes.'],
      [[{ type: 'upsert' }], '"changes[0].type" is insert, update or delete.'],
      [
        [{ type: 'update', key: {}, values: { a: 'b' } }],
        '"changes[0].key" names 1 to 1000 columns.',
      ],
      [
        [{ type: 'update', key: { id: '1' }, values: {} }],
        '"changes[0].values" names 1 to 1000 columns.',
      ],
      [[{ type: 'delete', key: { id: null } }], '"changes[0].key.id" is text.'],
      [[{ type: 'delete', key: { id: 1 } }], '"changes[0].key.id" is text.'],
      [[{ type: 'insert', values: { n: 5 } }], '"changes[0].values.n" is text or null.'],
      [[{ type: 'insert', values: ['x'] }], '"changes[0].values" maps column names to values.'],
    ])('refuses %j', async (bad, message) => {
      const { admin } = setup()
      const { status, body: answer } = await json(
        await admin.fetch(
          call('/db/api/apply', {
            body: { connection: 'main', schema: 'public', table: 'posts', changes: bad },
          }),
        ),
      )
      expect(status).toBe(400)
      expect(answer.error.message).toBe(message)
    })
  })

  describe('exporting', () => {
    it('streams the file to download, and audits how many rows went', async () => {
      const { admin, audit } = setup()
      const response = await admin.fetch(
        call('/db/api/export', {
          body: { connection: 'reports', schema: 'public', table: 'my posts', format: 'csv' },
        }),
      )
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="my_posts.csv"',
      )
      expect(await response.text()).toBe('id\r\n1\r\n2\r\n')
      await vi.waitFor(() =>
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'export',
            statement: 'public.my posts as csv',
            rows: 2,
          }),
        ),
      )
    })

    it('answers a table that fails at once with the error, not half a file', async () => {
      const failing = fakeDriver({
        // eslint-disable-next-line require-yield -- it fails before its first batch, as a missing table does
        export: async function* () {
          throw new QueryError('relation "nope" does not exist', '42P01')
        },
      })
      const { admin } = setup({}, failing)
      const { status, body } = await json(
        await admin.fetch(
          call('/db/api/export', {
            body: { connection: 'main', schema: 'public', table: 'nope', format: 'json' },
          }),
        ),
      )
      expect(status).toBe(400)
      expect(body.error.sqlState).toBe('42P01')
    })

    it('refuses a format it doesn’t write', async () => {
      const { admin } = setup()
      const { body } = await json(
        await admin.fetch(
          call('/db/api/export', {
            body: { connection: 'main', schema: 'public', table: 'posts', format: 'xlsx' },
          }),
        ),
      )
      expect(body.error.message).toBe('"format" is csv, json or sql.')
    })
  })

  describe('filters', () => {
    const page = (filters: unknown) => ({
      connection: 'main',
      schema: 'public',
      table: 'posts',
      filters,
    })

    it('passes valid conditions on, each with the values its operator takes', async () => {
      let seen: unknown
      const { admin } = setup(
        {},
        fakeDriver({
          rows: async (request) => {
            seen = request.filters
            return { columns: [], rows: [], truncated: false, durationMs: 0 }
          },
        }),
      )
      const filters = [
        { column: 'title', operator: 'contains', value: 'db' },
        { column: 'id', operator: 'in', value: ['1', '2'] },
        { column: 'id', operator: 'between', value: ['1', '9'] },
        { column: 'body', operator: 'is null', value: 'ignored' },
        { column: 'title', operator: '=', value: '' },
      ]
      expect((await admin.fetch(call('/db/api/rows', { body: page(filters) }))).status).toBe(200)
      expect(seen).toEqual([
        { column: 'title', operator: 'contains', value: 'db' },
        { column: 'id', operator: 'in', value: ['1', '2'] },
        { column: 'id', operator: 'between', value: ['1', '9'] },
        { column: 'body', operator: 'is null' },
        { column: 'title', operator: '=', value: '' },
      ])
    })

    it.each([
      [{ column: 'id', operator: 'regex', value: 'x' }, '"regex" isn\'t a filter.'],
      [{ column: 'id', operator: 'in', value: [] }, '"in" takes a list of 1 to 1000 values.'],
      [{ column: 'id', operator: 'in', value: '1,2' }, '"in" takes a list of 1 to 1000 values.'],
      [{ column: 'id', operator: 'between', value: ['1'] }, '"between" takes two values.'],
      [{ column: 'id', operator: '=', value: 1 }, '"=" takes one value.'],
      [{ operator: '=', value: '1' }, '"filters.column" is required.'],
    ])('refuses %o', async (filter, message) => {
      const { admin } = setup()
      const { status, body } = await json(
        await admin.fetch(call('/db/api/rows', { body: page([filter]) })),
      )
      expect(status).toBe(400)
      expect(body.error.message).toBe(message)
    })

    it('refuses more than 20 conditions', async () => {
      const { admin } = setup()
      const many = Array(21).fill({ column: 'id', operator: 'is null' })
      const { body } = await json(await admin.fetch(call('/db/api/count', { body: page(many) })))
      expect(body.error.message).toBe('"filters" is a list of up to 20 conditions.')
    })
  })

  describe('the browser app', () => {
    const page = (path: string) => new Request(`http://example.com${path}`)

    it('serves its page at the base path, with or without the slash, to anyone: the API it calls checks', async () => {
      const { admin } = setup({ ui: async () => UI, signInUrl: '/login?next=/db' })
      for (const path of ['/db', '/db/']) {
        const response = await admin.fetch(page(path))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
        const html = await response.text()
        expect(html).toContain('<script src="/db/assets/app-1.js">')
        expect(html).toContain(
          '<meta name="otw-db" content="{&quot;api&quot;:&quot;/db/api&quot;,&quot;signInUrl&quot;:&quot;/login?next=/db&quot;}">',
        )
      }
    })

    it('serves its files to be kept a year, as their names change with them', async () => {
      const { admin } = setup({ ui: async () => UI })
      const file = await admin.fetch(page('/db/assets/app-1.js'))
      expect(file.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await file.text()).toBe('console.log("app")')
      expect((await admin.fetch(page('/db/assets/nope.js'))).status).toBe(404)
      expect((await admin.fetch(page('/db/assets/__proto__'))).status).toBe(404)
      expect((await admin.fetch(page('/db/assets/a/b.js'))).status).toBe(404)
    })

    it('escapes what it writes into the page', async () => {
      const html = await renderIndex(UI, '/x"><script>', {
        api: '/x/api',
        signInUrl: '"><b>',
      }).text()
      expect(html).not.toMatch(/"><(script|b)>/)
      expect(html).toContain('/x&quot;&gt;&lt;script&gt;/assets/app-1.js')
    })

    it.each(['db', '/my db', '/x"><script>', '/a//b'])('refuses the base path %j', (basePath) => {
      expect(() => createDbAdmin({ basePath, connections: [], authorize: () => null })).toThrow(
        'basePath is a path such as "/db"',
      )
    })

    it('loads its files once, and again after a failure', async () => {
      let calls = 0
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { admin } = setup({
        ui: async () => {
          calls++
          if (calls === 1) throw new Error('not built')
          return UI
        },
      })
      expect((await admin.fetch(page('/db/'))).status).toBe(500)
      expect((await admin.fetch(page('/db/'))).status).toBe(200)
      expect((await admin.fetch(page('/db/assets/app-1.js'))).status).toBe(200)
      expect(calls).toBe(2)
      error.mockRestore()
    })

    it('serves the API alone with ui: false', async () => {
      const { admin } = setup({ ui: false })
      expect((await admin.fetch(page('/db/'))).status).toBe(404)
    })
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

describe('a connection’s other databases', () => {
  /** A server's databases: each its own fake driver, opened by withDatabase() and recorded. */
  function server(names = ['archive', 'shop']) {
    const opened: { name: string; close: ReturnType<typeof vi.fn> }[] = []
    const at = (name: string): Driver => {
      const close = vi.fn(async () => {})
      opened.push({ name, close })
      return fakeDriver({
        close,
        info: async () => ({
          product: 'PostgreSQL',
          version: '17.11',
          database: name,
          user: 'ana',
        }),
      }).driver
    }
    const base = fakeDriver({
      databases: async () => ({ current: 'shop', databases: names }),
      withDatabase: at,
    })
    return { base, opened }
  }

  it('says which connections open their server’s other databases', async () => {
    const { base } = server()
    const { admin } = setup({ connections: [MAIN, { ...REPORTS, databases: 'one' }] }, base)
    const { body } = await json(await admin.fetch(call('/db/api/connections')))
    expect(
      body.connections.map(
        (c: { capabilities: { databases: boolean } }) => c.capabilities.databases,
      ),
    ).toEqual([true, false])
  })

  it('lists the databases from the connection’s own', async () => {
    const { base } = server()
    const { admin } = setup({}, base)
    expect(await json(await admin.fetch(call('/db/api/databases?connection=main')))).toEqual({
      status: 200,
      body: { current: 'shop', databases: ['archive', 'shop'] },
    })
  })

  it.each([
    ['a connection pinned to its own', { ...MAIN, databases: 'one' as const }, server().base],
    ['a driver that opens one database only', MAIN, fakeDriver()],
  ])('refuses to list or open another database on %s', async (_, connection, driver) => {
    const { admin } = setup({ connections: [connection] }, driver)
    const message = 'Connection "main" opens its own database only.'
    for (const request of [
      call('/db/api/databases?connection=main'),
      call('/db/api/tables?connection=main&database=archive'),
      call('/db/api/query', { body: { connection: 'main', database: 'archive', sql: 'SELECT 1' } }),
    ]) {
      expect(await json(await admin.fetch(request))).toEqual({
        status: 400,
        body: { error: { code: 'one-database', message } },
      })
    }
  })

  it('runs each endpoint on the database named, opening it once, and audits which', async () => {
    const { base, opened } = server()
    const { admin, audit } = setup({}, base)
    const info = await json(
      await admin.fetch(call('/db/api/info?connection=main&database=archive')),
    )
    expect(info.body.info.database).toBe('archive')
    await admin.fetch(call('/db/api/tables?connection=main&database=archive'))
    await admin.fetch(
      call('/db/api/table?connection=main&database=archive&schema=public&name=posts'),
    )
    for (const [path, body] of [
      ['/db/api/rows', { schema: 'public', table: 'posts' }],
      ['/db/api/count', { schema: 'public', table: 'posts' }],
      ['/db/api/query', { sql: 'SELECT 1' }],
      [
        '/db/api/apply',
        { schema: 'public', table: 'posts', changes: [{ type: 'delete', key: { id: '1' } }] },
      ],
      ['/db/api/export', { schema: 'public', table: 'posts', format: 'csv' }],
    ] as const) {
      const response = await admin.fetch(
        call(path, { body: { connection: 'main', database: 'archive', ...body } }),
      )
      expect(response.status, path).toBe(200)
      await response.text()
    }
    expect(opened.map((d) => d.name)).toEqual(['archive'])
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(5))
    expect(audit.mock.calls.map(([event]) => [event.action, event.database])).toEqual([
      ['rows', 'archive'],
      ['count', 'archive'],
      ['query', 'archive'],
      ['apply', 'archive'],
      ['export', 'archive'],
    ])
  })

  it('uses the connection’s own database when none is named, and audits no database', async () => {
    const { base, opened } = server()
    const { admin, audit, calls } = setup({}, base)
    const info = await json(await admin.fetch(call('/db/api/info?connection=main&database=')))
    expect(info.body.info.database).toBe('shop')
    await admin.fetch(
      call('/db/api/query', { body: { connection: 'main', database: null, sql: 'SELECT 1' } }),
    )
    expect(calls).toHaveLength(1)
    expect(opened).toEqual([])
    expect(audit.mock.calls[0]![0]).not.toHaveProperty('database')
  })

  it.each([
    [{ database: 7 }, '"database" is a database’s name.'],
    [{ database: 'x'.repeat(64) }, '"database" is a database’s name.'],
    [{ database: 'é'.repeat(32) }, '"database" is a database’s name.'],
    [{ database: 'a\u0000b' }, '"database" is a database’s name.'],
  ])('refuses %o', async (body, message) => {
    const { admin } = setup({}, server().base)
    expect(
      await json(
        await admin.fetch(
          call('/db/api/query', { body: { connection: 'main', sql: 'SELECT 1', ...body } }),
        ),
      ),
    ).toEqual({ status: 400, body: { error: { code: 'bad-request', message } } })
  })

  it('answers an unknown connection before its database', async () => {
    const { admin } = setup({}, server().base)
    const { status, body } = await json(
      await admin.fetch(call('/db/api/tables?connection=nope&database=x')),
    )
    expect([status, body.error.code]).toEqual([404, 'unknown-connection'])
  })

  it('keeps the 8 databases used last open, closing the one used longest ago', async () => {
    const { base, opened } = server()
    const { admin } = setup({}, base)
    const use = (database: string) =>
      admin.fetch(call(`/db/api/tables?connection=main&database=${database}`))
    for (const database of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) await use(database)
    await use('d1')
    await use('d9')
    expect(opened.filter((d) => d.close.mock.calls.length).map((d) => d.name)).toEqual(['d2'])
    await use('d2')
    expect(opened.map((d) => d.name)).toEqual([
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7',
      'd8',
      'd9',
      'd2',
    ])
    await admin.close()
    expect(opened.filter((d) => !d.close.mock.calls.length)).toEqual([])
  })
})
