import { createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto'

/*
 * The password sign-in's session: a cookie the server can check with nothing kept on its side,
 * since a host's instances (Vercel's functions) share no memory. It holds when it ends, signed
 * with a key made from the password, so changing the password ends every session.
 */

export const SESSION_COOKIE = 'otw_db_session'
/** How long a sign-in lasts. */
export const SESSION_MS = 12 * 60 * 60 * 1000
/**
 * The shortest password taken. Nothing a server with no shared memory can count stops someone
 * guessing, so the password must be too long to guess: `init` makes one of 32 characters.
 */
export const MIN_PASSWORD = 16

/** A cookie's value by name, as the browser sent it. */
export function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/** Whether `password` is one the sign-in takes at all. */
export function usable(password: string | undefined): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD
}

/** Whether `given` is the password, compared so the time taken says nothing of either. */
export function samePassword(given: string, password: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(given), digest(password))
}

/**
 * The key sessions are signed with, made from the password the slow way (scrypt: 65 ms and 32 MB
 * a time). A cookie is checked with nothing but that key, so a cookie made from a guess at the
 * password and sent with any request says whether the guess was right, with none of the sign-in
 * page's waiting. Made slowly, each guess costs whoever makes it what a sign-in costs here; the
 * server makes its own once and keeps it.
 */
const keys = new Map<string, Promise<Buffer>>()

function keyOf(password: string, basePath: string): Promise<Buffer> {
  const id = `${basePath}\n${password}`
  let key = keys.get(id)
  if (!key) {
    key = new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        `otw-db-session:${basePath}`,
        32,
        { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, derived) => (error ? reject(error) : resolve(derived)),
      ),
    )
    // The password in use, and the one before it while a deploy rolls out: no more are kept.
    if (keys.size >= 4) keys.delete(keys.keys().next().value!)
    keys.set(id, key)
    key.catch(() => keys.delete(id))
  }
  return key
}

async function signature(expires: number, password: string, basePath: string): Promise<string> {
  return createHmac('sha256', await keyOf(password, basePath))
    .update(String(expires))
    .digest('base64url')
}

/** A session's cookie value: when it ends, and the signature that says this server set it. */
export async function signSession(
  password: string,
  basePath: string,
  now = Date.now(),
): Promise<string> {
  const expires = now + SESSION_MS
  return `${expires}.${await signature(expires, password, basePath)}`
}

/** Whether `value` is a session this password signed for this base path, not yet over. */
export async function verifySession(
  value: string | undefined,
  password: string,
  basePath: string,
  now = Date.now(),
): Promise<boolean> {
  const [expires, signed, ...rest] = (value ?? '').split('.')
  if (!expires || !signed || rest.length || !/^\d{1,16}$/.test(expires)) return false
  if (Number(expires) <= now) return false
  const expected = Buffer.from(await signature(Number(expires), password, basePath))
  const given = Buffer.from(signed)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * The Set-Cookie that starts a session, or ends it (`value` null). Only this tool's own paths
 * get it, never scripts (HttpOnly), never another site's requests (SameSite=Strict), and over
 * https only where the site is served so.
 */
export function sessionCookie(
  value: string | null,
  { basePath, secure }: { basePath: string; secure: boolean },
): string {
  return [
    `${SESSION_COOKIE}=${value ?? ''}`,
    `Path=${basePath || '/'}`,
    `Max-Age=${value === null ? 0 : Math.floor(SESSION_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}
