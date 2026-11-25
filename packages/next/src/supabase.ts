import { createHash } from 'node:crypto'
import { cookieOf } from './session.ts'

/*
 * Who is signed in to an app that uses Supabase Auth, without Supabase's packages: the session
 * is in a cookie `@supabase/ssr` sets, and Supabase itself says whose it is. Reading the cookie
 * alone would trust whatever a browser sends; the token in it is checked where it was issued.
 */

type Env = Readonly<Record<string, string | undefined>>

/** A signed-in user, as far as this tool needs: who, and their email once they've confirmed it. */
export interface SignedIn {
  id: string
  /** Only a confirmed address: an unconfirmed one is whatever someone typed when signing up. */
  email?: string
}

/** `expired`: there is a session, but its token has run out and the app must renew it. */
export type SupabaseUser = SignedIn | 'expired' | null

/** The project's address and the public key its browser clients use, from the app's env. */
export function supabaseProject(env: Env): { url: string; key: string } | null {
  const url = (env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL)?.trim().replace(/\/+$/, '')
  const key = (
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ??
    env.SUPABASE_ANON_KEY
  )?.trim()
  return url && key ? { url, key } : null
}

/** The session cookie's name, as supabase-js derives it from the project's address. */
export function sessionCookieName(url: string): string {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
}

/**
 * The access token in the session cookie: whole, or in numbered pieces when it's long
 * (`name.0`, `name.1`…), as JSON, plain or base64url after `base64-`.
 */
export function accessToken(request: Request, name: string): string | null {
  let value = cookieOf(request, name)
  if (value === undefined) {
    const pieces: string[] = []
    for (let i = 0; ; i++) {
      const piece = cookieOf(request, `${name}.${i}`)
      if (piece === undefined) break
      pieces.push(piece)
    }
    if (!pieces.length) return null
    value = pieces.join('')
  }
  try {
    const text = decodeURIComponent(value)
    const json = text.startsWith('base64-')
      ? Buffer.from(text.slice('base64-'.length), 'base64url').toString('utf8')
      : text
    const session = JSON.parse(json) as { access_token?: unknown } | unknown[]
    // The older helpers kept a list, the token first.
    const token = Array.isArray(session) ? session[0] : session?.access_token
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/** Whether a JWT says of itself that it has run out. Not trusted for anything else. */
function ranOut(token: string, now: number): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' && claims.exp * 1000 <= now
  } catch {
    return false
  }
}

/** Answers kept a minute per token, so a page's burst of requests asks Supabase once. */
const KEPT_MS = 60_000
const KEPT_MOST = 500
const kept = new Map<string, { at: number; user: SignedIn | null }>()

/**
 * Who the request's Supabase session belongs to, as Supabase says: null without a session, or
 * with one it doesn't know. `fetch` is the app's own, for tests to stand in for.
 */
export async function supabaseUser(
  request: Request,
  env: Env = process.env,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<SupabaseUser> {
  const project = supabaseProject(env)
  if (!project) return null
  const token = accessToken(request, sessionCookieName(project.url))
  if (!token) return null
  const now = options.now ?? Date.now()
  if (ranOut(token, now)) return 'expired'
  const key = createHash('sha256').update(`${project.url}\n${token}`).digest('hex')
  const known = kept.get(key)
  if (known && now - known.at < KEPT_MS) return known.user
  let user: SignedIn | null = null
  try {
    const response = await (options.fetch ?? fetch)(`${project.url}/auth/v1/user`, {
      headers: { apikey: project.key, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.ok) {
      const body = (await response.json()) as {
        id?: unknown
        email?: unknown
        email_confirmed_at?: unknown
      }
      if (typeof body.id === 'string' && body.id) {
        user = {
          id: body.id,
          ...(typeof body.email === 'string' && body.email && body.email_confirmed_at
            ? { email: body.email }
            : {}),
        }
      }
    }
  } catch (error) {
    // Unreachable, not refused: nobody is let in on it, and the next request asks again.
    console.warn('otw-db: could not ask Supabase who is signed in', error)
    return null
  }
  if (kept.size >= KEPT_MOST) kept.delete(kept.keys().next().value!)
  kept.set(key, { at: now, user })
  return user
}
