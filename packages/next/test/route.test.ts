import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AuditEvent } from '@otwdesign/db-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDbRoute, type DbRouteOptions } from '../src/index.ts'

/*
 * The route as an app has it: a real database behind it (a SQLite file), and requests as a
 * browser sends them.
 */

const PASSWORD = 'correct horse battery staple'
const SITE = 'https://app.example'
let dir: string
let url: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otw-db-next-'))
  const file = join(dir, 'app.db')
  const db = new DatabaseSync(file)
  db.exec(
    `CREATE TABLE guests (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO guests VALUES (1, 'Ada')`,
  )
  db.close()
  url = `sqlite:${file}`
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function route(env: Record<string, string | undefined>, options: DbRouteOptions = {}) {
  const audit = vi.fn<(event: AuditEvent) => void>()
  return { ...createDbRoute({ env: { DB_ADMIN_MAIN_URL: url, ...env }, audit, ...options }), audit }
}

const get = (path: string, cookie?: string) =>
  new Request(`${SITE}${path}`, { headers: cookie ? { cookie } : {} })

/** A call of the browser app's to the API. */
const api = (path: string, cookie?: string, body?: unknown) =>
  new Request(`${SITE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-db-admin': '1',
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** The sign-in form, posted as a browser posts it. */
const post = (path: string, password: string | null, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: SITE,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: password === null ? '' : new URLSearchParams({ password }).toString(),
  })

/** The cookie a response set, as the browser would send it back. */
const cookieFrom = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!

describe('createDbRoute, with a password', () => {
  it('serves the tool’s page to anyone, and its data to nobody not signed in', async () => {
    const { GET } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const page = await GET(get('/db'))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<meta name="otw-db"')
    // The app's page sends whoever the API turns away to this package's sign-in.
    expect(html).toContain('&quot;signInUrl&quot;:&quot;/db/sign-in&quot;')
    const refused = await GET(api('/db/api/connections'))
    expect(refused.status).toBe(401)
  })

  it('signs in whoever has the password, with a cookie for the tool’s paths only', async () => {
    const { GET, POST, audit } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const form = await GET(get('/db/sign-in'))
    expect(form.status).toBe(200)
    expect(form.headers.get('content-security-policy')).toContain("form-action 'self'")
    expect(form.headers.get('cache-control')).toBe('no-store')
    const html = await form.text()
    expect(html).toContain('<form method="post" action="/db/sign-in">')
    expect(html).not.toContain('<script')

    const signedIn = await POST(post('/db/sign-in', PASSWORD))
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.get('location')).toBe('/db')
    expect(signedIn.headers.get('set-cookie')).toMatch(
      /^otw_db_session=\d+\.[\w-]+; Path=\/db; Max-Age=43200; HttpOnly; SameSite=Strict; Secure$/,
    )
    const cookie = cookieFrom(signedIn)
    const listed = await GET(api('/db/api/connections', cookie))
    expect(listed.status).toBe(200)
    expect((await listed.json()).connections).toMatchObject([
      { name: 'main', kind: 'sqlite', access: 'read' },
    ])
    const rows = await POST(
      api('/db/api/query', cookie, { connection: 'main', sql: 'SELECT name FROM guests' }),
    )
    expect((await rows.json()).rows).toEqual([['Ada']])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ viewer: 'password' }))
  })

  it('refuses a wrong password, after a wait, and sets nothing', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { POST } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const started = performance.now()
    const refused = await POST(post('/db/sign-in', `${PASSWORD}!`))
    expect(performance.now() - started).toBeGreaterThanOrEqual(480)
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toBeNull()
    expect(await refused.text()).toContain('That isn’t the password.')
    expect((await POST(post('/db/sign-in', null))).status).toBe(401)
    expect(warned).toHaveBeenCalledWith('otw-db: a sign-in at /db was refused')
    warned.mockRestore()
  })

  it('takes no password that isn’t set, or is too short to be safe, and says which', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unset = route({})
    expect(await (await unset.GET(get('/db/sign-in'))).text()).toContain(
      'No password is set. Set <code>DB_ADMIN_PASSWORD</code>',
    )
    expect((await unset.POST(post('/db/sign-in', ''))).status).toBe(401)
    const short = route({ DB_ADMIN_PASSWORD: 'short' })
    const page = await (await short.GET(get('/db/sign-in'))).text()
    expect(page).toContain('needs 16 characters or more')
    expect(page).not.toContain('<form')
    const refused = await short.POST(post('/db/sign-in', 'short'))
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toBeNull()
    warned.mockRestore()
  })

  it('takes a sign-in from its own site only', async () => {
    const { POST } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const elsewhere: Record<string, string>[] = [
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site' },
    ]
    for (const headers of elsewhere) {
      const response = await POST(post('/db/sign-in', PASSWORD, headers))
      expect(response.status, JSON.stringify(headers)).toBe(403)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    // Behind a proxy that renames the host, the browser's origin is the forwarded one.
    const proxied = await POST(
      new Request('http://internal:3000/db/sign-in', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: SITE,
          'x-forwarded-host': 'app.example',
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams({ password: PASSWORD }).toString(),
      }),
    )
    expect(proxied.status).toBe(303)
    expect(proxied.headers.get('set-cookie')).toContain('; Secure')
  })

  it('sets a cookie a plain-http site can send back, and signs out', async () => {
    const { GET, POST } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const local = await POST(
      new Request('http://localhost:3000/db/sign-in', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://localhost:3000',
        },
        body: new URLSearchParams({ password: PASSWORD }).toString(),
      }),
    )
    expect(local.headers.get('set-cookie')).not.toContain('Secure')

    const cookie = cookieFrom(await POST(post('/db/sign-in', PASSWORD)))
    const already = await (await GET(get('/db/sign-in', cookie))).text()
    expect(already).toContain('You’re signed in')
    expect(already).toContain('<form class="row" method="post" action="/db/sign-out">')
    const out = await POST(post('/db/sign-out', null, { cookie }))
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe('/db/sign-in')
    expect(out.headers.get('set-cookie')).toMatch(/^otw_db_session=; Path=\/db; Max-Age=0;/)
    expect(
      (await POST(post('/db/sign-out', null, { origin: 'https://evil.example' }))).status,
    ).toBe(403)
  })

  it('ends every session when the password changes', async () => {
    const before = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const cookie = cookieFrom(await before.POST(post('/db/sign-in', PASSWORD)))
    const after = route({ DB_ADMIN_PASSWORD: 'another long password!' })
    expect((await after.GET(api('/db/api/connections', cookie))).status).toBe(401)
  })
})

describe('createDbRoute, with the app’s own users', () => {
  const env = { DB_ADMIN_PASSWORD: PASSWORD, DB_ADMIN_USERS: 'Tahir@otw.design, ana@example.com' }

  it('lets a listed user in with no password, and audits who it was', async () => {
    const user = vi.fn(async (request: Request) => request.headers.get('x-test-user'))
    const { GET, POST, audit } = route(env, { user })
    const as = (email: string) =>
      new Request(`${SITE}/db/api/query`, {
        method: 'POST',
        headers: { 'x-db-admin': '1', 'content-type': 'application/json', 'x-test-user': email },
        body: JSON.stringify({ connection: 'main', sql: 'SELECT 1' }),
      })
    expect((await POST(as('tahir@OTW.design'))).status).toBe(200)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ viewer: 'tahir@otw.design' }))
    expect((await POST(as('mallory@example.com'))).status).toBe(401)
    expect((await GET(api('/db/api/connections'))).status).toBe(401)
    // The page for someone already in says who, and how to leave.
    const page = await GET(
      new Request(`${SITE}/db/sign-in`, { headers: { 'x-test-user': 'ana@example.com' } }),
    )
    expect(await page.text()).toContain('As ana@example.com, one of the app’s users let in here.')
  })

  it('still takes the password from everyone else, and tells them of the other way in', async () => {
    const { GET, POST } = route(env, { user: async () => null })
    const page = await (await GET(get('/db/sign-in'))).text()
    expect(page).toContain('<form method="post" action="/db/sign-in">')
    expect(page).toContain('Or sign in to the app as one of the users it lets in here')
    const cookie = cookieFrom(await POST(post('/db/sign-in', PASSWORD)))
    expect((await GET(api('/db/api/connections', cookie))).status).toBe(200)
  })

  it('lets only listed users in when no password is set', async () => {
    const { GET, POST } = route(
      { DB_ADMIN_USERS: 'tahir@otw.design' },
      { user: async (request) => request.headers.get('x-test-user') },
    )
    const page = await (await GET(get('/db/sign-in'))).text()
    expect(page).not.toContain('<form')
    expect(page).toContain('Sign in to the app as one of the users it lets in here')
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await POST(post('/db/sign-in', 'anything at all, long enough'))).status).toBe(401)
    warned.mockRestore()
    const listed = await GET(
      new Request(`${SITE}/db/api/connections`, {
        headers: { 'x-db-admin': '1', 'x-test-user': 'tahir@otw.design' },
      }),
    )
    expect(listed.status).toBe(200)
  })

  it('reads a Supabase session where the app gives no way of its own to ask', async () => {
    const supabase = 'https://abcdefghijklmnop.supabase.co'
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = (extra: object) =>
      `${part({ alg: 'HS256' })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600, ...extra })}.sig`
    const session = (accessToken: string) =>
      `sb-abcdefghijklmnop-auth-token=base64-${part({ access_token: accessToken })}`
    /** Supabase, standing in: it knows the token's owner by what the test put in it. */
    const asked = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${supabase}/auth/v1/user`)
      const bearer = (init?.headers as Record<string, string>).authorization!.slice(
        'Bearer '.length,
      )
      const { who } = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as {
        who: string
      }
      return Response.json({
        id: `id-of-${who}`,
        email: `${who}@example.com`,
        email_confirmed_at: '2026-01-01T00:00:00Z',
      })
    })
    vi.stubGlobal('fetch', asked)
    try {
      const { GET } = route({
        ...env,
        NEXT_PUBLIC_SUPABASE_URL: supabase,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      })
      const ana = await GET(api('/db/api/connections', session(token({ who: 'ana' }))))
      expect(ana.status).toBe(200)
      const stranger = await GET(api('/db/api/connections', session(token({ who: 'bob' }))))
      expect(stranger.status).toBe(401)
      // Run out, it's the app that renews it: the page says so.
      const old = `${part({ alg: 'HS256' })}.${part({ exp: 1 })}.sig`
      const page = await (await GET(get('/db/sign-in', session(old)))).text()
      expect(page).toContain('Your sign-in to the app has run out.')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('createDbRoute, in an app', () => {
  it('does nothing when it’s made, so a build without the app’s environment goes through', () => {
    const before = { ...process.env }
    delete process.env.DB_ADMIN_PASSWORD
    try {
      expect(() => createDbRoute()).not.toThrow()
      expect(() => createDbRoute({ env: { DATABASE_URL: 'nonsense://x' } })).not.toThrow()
    } finally {
      process.env = before
    }
  })

  it('answers at the same place with a slash after it, as trailingSlash sends requests', async () => {
    const { GET, POST } = route({ DB_ADMIN_PASSWORD: PASSWORD })
    const cookie = cookieFrom(await POST(post('/db/sign-in/', PASSWORD)))
    expect((await GET(api('/db/api/connections/', cookie))).status).toBe(200)
    expect((await GET(get('/db/'))).status).toBe(200)
  })

  it('lives where the app puts it, under next.config’s basePath too', async () => {
    const { GET, POST } = route({ DB_ADMIN_PASSWORD: PASSWORD }, { basePath: '/docs/admin/db/' })
    const signedIn = await POST(post('/docs/admin/db/sign-in', PASSWORD))
    expect(signedIn.headers.get('location')).toBe('/docs/admin/db')
    expect(signedIn.headers.get('set-cookie')).toContain('Path=/docs/admin/db;')
    expect((await GET(api('/docs/admin/db/api/connections', cookieFrom(signedIn)))).status).toBe(
      200,
    )
    expect((await GET(get('/db/sign-in'))).status).toBe(404)
  })

  it('opens the app’s own database, read-only, when it names none', async () => {
    const { GET, POST } = createDbRoute({
      env: { DB_ADMIN_PASSWORD: PASSWORD, DATABASE_URL: url },
      audit: false,
    })
    const cookie = cookieFrom(await POST(post('/db/sign-in', PASSWORD)))
    const { connections } = await (await GET(api('/db/api/connections', cookie))).json()
    expect(connections).toMatchObject([{ name: 'app', label: 'This app', access: 'read' }])
  })

  it('steps aside for an app that decides for itself who gets in', async () => {
    const { GET, POST } = route(
      { DB_ADMIN_PASSWORD: PASSWORD, DB_ADMIN_USERS: 'tahir@otw.design' },
      {
        authorize: (request) =>
          request.headers.get('x-role') === 'admin' ? { id: 'the-app' } : null,
        signInUrl: '/login',
      },
    )
    const page = await (await GET(get('/db'))).text()
    expect(page).toContain('&quot;signInUrl&quot;:&quot;/login&quot;')
    // No page of this package's, and no cookie of its own taken.
    expect((await GET(get('/db/sign-in'))).status).toBe(404)
    expect((await POST(post('/db/sign-in', PASSWORD))).status).toBe(404)
    const admin = await GET(
      new Request(`${SITE}/db/api/connections`, {
        headers: { 'x-db-admin': '1', 'x-role': 'admin' },
      }),
    )
    expect(admin.status).toBe(200)
    expect((await GET(api('/db/api/connections'))).status).toBe(401)
  })
})
