import { describe, expect, it } from 'vitest'
import {
  cookieOf,
  samePassword,
  SESSION_MS,
  sessionCookie,
  signSession,
  usable,
  verifySession,
} from '../src/session.ts'

const PASSWORD = 'correct horse battery staple'
const NOW = Date.UTC(2026, 10, 25, 12)

describe('the password session', () => {
  it('is a cookie the server can check with nothing kept: when it ends, signed', async () => {
    const value = await signSession(PASSWORD, '/db', NOW)
    expect(value).toMatch(new RegExp(`^${NOW + SESSION_MS}\\.[A-Za-z0-9_-]{43}$`))
    expect(await verifySession(value, PASSWORD, '/db', NOW + 1)).toBe(true)
    expect(await verifySession(value, PASSWORD, '/db', NOW + SESSION_MS - 1)).toBe(true)
  })

  it('ends when its time is up', async () => {
    const value = await signSession(PASSWORD, '/db', NOW)
    expect(await verifySession(value, PASSWORD, '/db', NOW + SESSION_MS)).toBe(false)
  })

  it('is refused when its end was moved, or its signature isn’t this server’s', async () => {
    const value = await signSession(PASSWORD, '/db', NOW)
    const [expires, signature] = value.split('.') as [string, string]
    expect(await verifySession(`${Number(expires) + 1}.${signature}`, PASSWORD, '/db', NOW)).toBe(
      false,
    )
    expect(await verifySession(`${expires}.${signature.slice(0, -1)}A`, PASSWORD, '/db', NOW)).toBe(
      false,
    )
    expect(await verifySession(`${expires}.${signature}.x`, PASSWORD, '/db', NOW)).toBe(false)
    for (const junk of [undefined, '', 'x', '.', '12.', `${expires}`, `nine.${signature}`]) {
      expect(await verifySession(junk, PASSWORD, '/db', NOW), String(junk)).toBe(false)
    }
  })

  it('ends for everyone when the password changes, and is no good at another path', async () => {
    const value = await signSession(PASSWORD, '/db', NOW)
    expect(await verifySession(value, `${PASSWORD}!`, '/db', NOW)).toBe(false)
    expect(await verifySession(value, PASSWORD, '/admin/db', NOW)).toBe(false)
  })

  it('costs whoever forges one from a guess what a sign-in costs, a cookie at a time', async () => {
    // A cookie signed with a guess says whether the guess was right when it's sent, past the
    // sign-in page and its wait. Its key is made slowly, so guesses can't be made in bulk: the
    // key from the password by one quick HMAC, as it was, isn't the key any more.
    const { createHmac } = await import('node:crypto')
    const value = await signSession(PASSWORD, '/db', NOW)
    const [expires, signature] = value.split('.') as [string, string]
    const quick = createHmac('sha256', PASSWORD).update('otw-db-session:/db').digest()
    expect(createHmac('sha256', quick).update(expires).digest('base64url')).not.toBe(signature)
    // The server's own key is made once: checking a cookie again is quick.
    const started = performance.now()
    for (let i = 0; i < 200; i++) await verifySession(value, PASSWORD, '/db', NOW)
    expect(performance.now() - started).toBeLessThan(100)
    // A guess's key is another matter: tens of milliseconds each, on any machine.
    const guessing = performance.now()
    for (let i = 0; i < 3; i++) await signSession(`a wrong guess, number ${i} of them`, '/db', NOW)
    expect((performance.now() - guessing) / 3).toBeGreaterThan(15)
  })

  it('takes a password of 16 characters or more, and compares it whole', async () => {
    expect(usable(undefined)).toBe(false)
    expect(usable('')).toBe(false)
    expect(usable('fifteen chars!!!'.slice(0, 15))).toBe(false)
    expect(usable('sixteen chars!!!')).toBe(true)
    expect(samePassword(PASSWORD, PASSWORD)).toBe(true)
    expect(samePassword(PASSWORD.slice(0, -1), PASSWORD)).toBe(false)
    expect(samePassword('', PASSWORD)).toBe(false)
  })

  it('is set for the tool’s own paths only, out of scripts’ and other sites’ reach', async () => {
    expect(sessionCookie('v', { basePath: '/db', secure: true })).toBe(
      `otw_db_session=v; Path=/db; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict; Secure`,
    )
    expect(sessionCookie(null, { basePath: '', secure: false })).toBe(
      'otw_db_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
    )
  })

  it('reads a cookie by its exact name', async () => {
    const request = new Request('http://x/', {
      headers: { cookie: 'a=1; otw_db_session=12.ab; xotw_db_session=no; b=x=y' },
    })
    expect(cookieOf(request, 'otw_db_session')).toBe('12.ab')
    expect(cookieOf(request, 'b')).toBe('x=y')
    expect(cookieOf(request, 'missing')).toBeUndefined()
    expect(cookieOf(new Request('http://x/'), 'a')).toBeUndefined()
  })
})
