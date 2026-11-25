import { createServerClient } from '@supabase/ssr'
import { describe, expect, it, vi } from 'vitest'
import { accessToken, sessionCookieName, supabaseProject, supabaseUser } from '../src/supabase.ts'

const URL_ = 'https://abcdefghijklmnop.supabase.co'
const ENV = { NEXT_PUBLIC_SUPABASE_URL: URL_, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key' }
/** The tests' clock. Tokens end a year after it, so the library, on the machine's clock, takes them. */
const NOW = Date.now()
const YEAR = 365 * 24 * 3600

/** A token shaped as Supabase's: only its expiry is read here, and Supabase itself is asked the rest. */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.${Buffer.from('signature').toString('base64url')}`
}

const USER = {
  id: '11111111-2222-3333-4444-555555555555',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'Tahir@otw.design',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}

/**
 * The cookies `@supabase/ssr` itself sets for a session, as a browser would send them back: the
 * reader is tested against what the library writes, not against a guess at it.
 */
async function cookiesFor(token: string, user: Record<string, unknown> = USER): Promise<string> {
  const jar = new Map<string, string>()
  const client = createServerClient(URL_, 'anon-key', {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) {
          if (value) jar.set(name, value)
          else jar.delete(name)
        }
      },
    },
    global: { fetch: async () => Response.json(user) },
  })
  const { error } = await client.auth.setSession({ access_token: token, refresh_token: 'refresh' })
  if (error) throw error
  // The library writes its cookies when the sign-in event has gone round.
  await vi.waitFor(() => expect(jar.size).toBeGreaterThan(0))
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
}

const request = (cookie: string) => new Request('https://app.example/db', { headers: { cookie } })

describe('an app on Supabase Auth', () => {
  it('is found by its public address and key, under the names apps give them', () => {
    expect(supabaseProject(ENV)).toEqual({ url: URL_, key: 'anon-key' })
    expect(
      supabaseProject({ SUPABASE_URL: `${URL_}/`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk' }),
    ).toEqual({ url: URL_, key: 'pk' })
    expect(supabaseProject({ NEXT_PUBLIC_SUPABASE_URL: URL_ })).toBeNull()
    expect(supabaseProject({})).toBeNull()
    expect(sessionCookieName(URL_)).toBe('sb-abcdefghijklmnop-auth-token')
  })

  it('reads the token from the cookie @supabase/ssr sets', async () => {
    const token = jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR })
    const cookie = await cookiesFor(token)
    expect(cookie).toContain('sb-abcdefghijklmnop-auth-token')
    expect(accessToken(request(cookie), sessionCookieName(URL_))).toBe(token)
  })

  it('reads it from a cookie too long for one, split into numbered pieces', async () => {
    const token = jwt({
      sub: USER.id,
      exp: Math.floor(NOW / 1000) + YEAR,
      padding: 'x'.repeat(6000),
    })
    const cookie = await cookiesFor(token)
    expect(cookie).toContain('sb-abcdefghijklmnop-auth-token.0=')
    expect(cookie).toContain('sb-abcdefghijklmnop-auth-token.1=')
    expect(accessToken(request(cookie), sessionCookieName(URL_))).toBe(token)
  })

  it('reads the older forms: plain JSON, and a list with the token first', () => {
    const name = sessionCookieName(URL_)
    const plain = encodeURIComponent(JSON.stringify({ access_token: 'a.b.c' }))
    expect(accessToken(request(`${name}=${plain}`), name)).toBe('a.b.c')
    const list = encodeURIComponent(JSON.stringify(['a.b.c', 'refresh']))
    expect(accessToken(request(`${name}=${list}`), name)).toBe('a.b.c')
    for (const junk of ['base64-!!!', 'not json', encodeURIComponent('{}'), '%E0%A4%A']) {
      expect(accessToken(request(`${name}=${junk}`), name), junk).toBeNull()
    }
    expect(accessToken(request('other=1'), name)).toBeNull()
  })

  it('asks Supabase whose the session is, and takes only a confirmed email', async () => {
    const cookie = await cookiesFor(jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 1 }))
    const asked = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(USER))
    expect(await supabaseUser(request(cookie), ENV, { fetch: asked, now: NOW })).toEqual({
      id: USER.id,
      email: 'Tahir@otw.design',
    })
    const [url, init] = asked.mock.calls[0]!
    expect(String(url)).toBe(`${URL_}/auth/v1/user`)
    expect(init?.headers).toMatchObject({ apikey: 'anon-key' })
    expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer ey/)

    const unconfirmed = await cookiesFor(
      jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 2 }),
    )
    expect(
      await supabaseUser(request(unconfirmed), ENV, {
        fetch: async () => Response.json({ ...USER, email_confirmed_at: null }),
        now: NOW,
      }),
    ).toEqual({ id: USER.id })
  })

  it('asks once a minute for the same session, not once a request', async () => {
    const cookie = await cookiesFor(jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 3 }))
    const asked = vi.fn(async () => Response.json(USER))
    for (const later of [0, 1_000, 59_000]) {
      await supabaseUser(request(cookie), ENV, { fetch: asked, now: NOW + later })
    }
    expect(asked).toHaveBeenCalledTimes(1)
    await supabaseUser(request(cookie), ENV, { fetch: asked, now: NOW + 61_000 })
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('lets nobody in on a token Supabase refuses, or when it can’t be reached', async () => {
    const refused = await cookiesFor(
      jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 4 }),
    )
    expect(
      await supabaseUser(request(refused), ENV, {
        fetch: async () => Response.json({ msg: 'invalid JWT' }, { status: 401 }),
        now: NOW,
      }),
    ).toBeNull()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = await cookiesFor(jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 5 }))
    expect(
      await supabaseUser(request(down), ENV, {
        fetch: async () => {
          throw new Error('fetch failed')
        },
        now: NOW,
      }),
    ).toBeNull()
    expect(warned).toHaveBeenCalled()
    warned.mockRestore()
  })

  it('says a session has run out, without asking, so the page can say what to do', async () => {
    const cookie = await cookiesFor(jwt({ sub: USER.id, exp: Math.floor(NOW / 1000) + YEAR, n: 6 }))
    const asked = vi.fn(async () => Response.json(USER))
    expect(
      await supabaseUser(request(cookie), ENV, { fetch: asked, now: NOW + (YEAR + 1) * 1000 }),
    ).toBe('expired')
    expect(asked).not.toHaveBeenCalled()
  })

  it('knows nobody where the app isn’t on Supabase, or has no session', async () => {
    const asked = vi.fn(async () => Response.json(USER))
    expect(await supabaseUser(request('a=1'), ENV, { fetch: asked })).toBeNull()
    expect(await supabaseUser(request('a=1'), {}, { fetch: asked })).toBeNull()
    expect(asked).not.toHaveBeenCalled()
  })
})
