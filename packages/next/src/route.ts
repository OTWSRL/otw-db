import {
  createDbAdmin,
  openDriver,
  type ConnectionConfig,
  type DbAdmin,
  type DbAdminOptions,
  type PostgresOptions,
  type Viewer,
} from '@otwdesign/db-core'
import { appConnections } from './connections.ts'
import {
  cookieOf,
  samePassword,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
  usable,
  verifySession,
} from './session.ts'
import { redirect, signedInPage, signInPage } from './sign-in.ts'
import { supabaseUser } from './supabase.ts'
import { listedAs, listedUsers } from './users.ts'

type Env = Readonly<Record<string, string | undefined>>

/** What `createDbRoute` takes: all of it optional, for an app that sets its env and nothing else. */
export interface DbRouteOptions extends Partial<
  Omit<DbAdminOptions, 'authorize' | 'basePath' | 'connections'>
> {
  /**
   * Where the route is: `/db` for `app/db/[[...path]]/route.ts`. With `basePath` set in
   * next.config, that comes first, as the browser has it: `/docs/db`.
   */
  basePath?: string
  /** The databases to open. Defaults to `appConnections()`: DB_ADMIN_<NAME>_URL, or the app's own. */
  connections?: readonly ConnectionConfig[]
  /** The password that signs anyone in. Defaults to DB_ADMIN_PASSWORD; 16 characters at least. */
  password?: string
  /**
   * The app's own users who get in without the password, by email (or id), separated by commas.
   * Defaults to DB_ADMIN_USERS.
   */
  users?: string
  /**
   * Who is signed in to the app, as its own sign-in knows them: their email, or an id, to look up
   * among `users`. Without it, an app on Supabase Auth has its session read; any other sign-in
   * (Auth.js, Clerk, the app's own) is asked here.
   */
  user?(request: Request): string | null | undefined | Promise<string | null | undefined>
  /**
   * The app's own decision, instead of the password and the users list: who is asking, or null.
   * With it, this package serves no sign-in page; set `signInUrl` to the app's.
   */
  authorize?: DbAdminOptions['authorize']
  /** The environment read for the defaults. `process.env`, unless a test says otherwise. */
  env?: Env
}

/** The route's handlers, as a Next.js route file exports them. */
export interface DbRoute {
  GET(request: Request): Promise<Response>
  POST(request: Request): Promise<Response>
}

/**
 * pg and pg-cursor from this package's own dependencies. db-core imports its drivers where the
 * app runs, hidden from bundlers so an app builds without the ones it doesn't install; but what
 * a bundler can't see, Next's file tracing doesn't copy into a Vercel function either, and there
 * the first query would find no pg-cursor. Imported here in plain sight, they're traced.
 */
const postgres: PostgresOptions = {
  modules: () => Promise.all([import('pg'), import('pg-cursor')]),
}

/**
 * How long a wrong password waits for its answer, and how many may be waiting. They're answered
 * one after another, not all at once: a guesser gets two tries a second from a server, however
 * many connections it opens. Past the few that wait, a sign-in is turned away unread, the right
 * password too: answered by whether it was right, it would be a guess with no wait at all.
 */
const WRONG_PASSWORD_MS = 500
const WRONG_PASSWORDS_WAITING = 8
/** How long a sign-in's form has to arrive, and how much of one is read. */
const FORM_MS = 2_000
const FORM_BYTES = 4_096

/**
 * OTW DB as a Next.js route: `export const { GET, POST } = createDbRoute()` in
 * `app/db/[[...path]]/route.ts`. It signs people in itself: anyone with DB_ADMIN_PASSWORD, and
 * the app's signed-in users listed in DB_ADMIN_USERS with no password at all.
 *
 * Nothing is read or opened until the first request: Next imports a route when it builds, where
 * the app's environment isn't there yet.
 */
export function createDbRoute(options: DbRouteOptions = {}): DbRoute {
  const {
    basePath: givenBase,
    connections,
    password: givenPassword,
    users: givenUsers,
    user: appUser,
    authorize: appAuthorize,
    env: givenEnv,
    ...rest
  } = options
  const basePath = (givenBase ?? '/db').replace(/\/+$/, '')
  const env = () => givenEnv ?? process.env
  const password = () => givenPassword ?? env().DB_ADMIN_PASSWORD
  const listed = () => listedUsers(givenUsers ?? env().DB_ADMIN_USERS)

  /** The app's signed-in user who is on the list: who, or that their sign-in has run out. */
  async function listedUser(request: Request): Promise<{ who?: string; expired?: boolean }> {
    const list = listed()
    if (!list.size) return {}
    if (appUser) return { who: listedAs(list, [await appUser(request)]) }
    const user = await supabaseUser(request, env())
    if (user === 'expired') return { expired: true }
    return { who: user ? listedAs(list, [user.email, user.id]) : undefined }
  }

  async function hasSession(request: Request): Promise<boolean> {
    const set = password()
    return usable(set) && (await verifySession(cookieOf(request, SESSION_COOKIE), set, basePath))
  }

  /** Listed users first, so the audit log has who it was, not only that they knew the password. */
  async function authorize(request: Request): Promise<Viewer | null> {
    const { who } = await listedUser(request)
    if (who) return { id: who }
    return (await hasSession(request)) ? { id: 'password' } : null
  }

  let admin: DbAdmin | undefined
  const tool = () =>
    (admin ??= createDbAdmin({
      driver: (connection) => openDriver(connection, { postgres }),
      ...(appAuthorize ? {} : { signInUrl: `${basePath}/sign-in` }),
      ...rest,
      basePath,
      connections: connections ?? appConnections(env()),
      authorize: appAuthorize ?? authorize,
    }))

  /** The sign-ins being looked at or waiting for their answer, and the wait of the last wrong one. */
  let waiting = 0
  let lastRefusal: Promise<void> = Promise.resolve()

  async function signIn(request: Request): Promise<Response> {
    const set = password()
    const state = {
      basePath,
      password: usable(set) ? ('ready' as const) : set ? ('short' as const) : ('unset' as const),
      listed: listed().size > 0,
    }
    const { who, expired } = await listedUser(request)
    if (request.method === 'GET') {
      if (who) return signedInPage(basePath, who)
      if (await hasSession(request)) return signedInPage(basePath, null)
      return signInPage({ ...state, ...(expired ? { expired } : {}) })
    }
    if (!sameOrigin(request)) return new Response('Sign in from this site.', { status: 403 })
    // Counted at the door, before the form is read: every one of a crowd arrives before the
    // first of them has been found wrong.
    if (waiting >= WRONG_PASSWORDS_WAITING) {
      return signInPage({ ...state, busy: true }, 429, { 'retry-after': '5' })
    }
    waiting += 1
    try {
      const given = await passwordOf(request)
      // No password came (a form that never arrived, or had none): nothing was guessed, so
      // nothing waits, and its place is free again.
      if (given === null) return signInPage(state, 400)
      if (!usable(set) || !samePassword(given, set)) {
        const turn = lastRefusal.then(
          () => new Promise<void>((resolve) => setTimeout(resolve, WRONG_PASSWORD_MS)),
        )
        lastRefusal = turn
        await turn
        console.warn(`otw-db: a sign-in at ${basePath} was refused`)
        return signInPage({ ...state, wrong: usable(set) }, 401)
      }
      return redirect(
        basePath || '/',
        sessionCookie(await signSession(set, basePath), { basePath, secure: secure(request) }),
      )
    } finally {
      waiting -= 1
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Next's trailingSlash sends /db/api/rows to /db/api/rows/, which is the same place.
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      // Counted from the end: a pattern for "slashes at the end" is tried from every slash of
      // a long run of them that doesn't reach it.
      let end = url.pathname.length
      while (end > 1 && url.pathname.charCodeAt(end - 1) === 47) end -= 1
      url.pathname = url.pathname.slice(0, end)
      request = new Request(url, request)
    }
    if (!appAuthorize) {
      if (url.pathname === `${basePath}/sign-in`) return signIn(request)
      if (url.pathname === `${basePath}/sign-out` && request.method === 'POST') {
        if (!sameOrigin(request)) return new Response('Sign out from this site.', { status: 403 })
        return redirect(
          `${basePath}/sign-in`,
          sessionCookie(null, { basePath, secure: secure(request) }),
        )
      }
    }
    return tool().fetch(request)
  }

  return { GET: handle, POST: handle }
}

/** The password a sign-in form posted, or null where there is none to read. */
async function passwordOf(request: Request): Promise<string | null> {
  // A form that never finishes arriving would keep its place among the sign-ins being looked
  // at for as long as it liked; one of megabytes would be read whole and hashed. Two seconds,
  // and a few kilobytes: a password and nothing else.
  if (Number(request.headers.get('content-length') ?? 0) > FORM_BYTES) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FORM_MS)
  })
  const chunks: Uint8Array[] = []
  let read = 0
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late])
      if (!next) return null
      if (next.done) break
      read += next.value.byteLength
      if (read > FORM_BYTES) return null
      chunks.push(next.value)
    }
    const given = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('password')
    return given ? given : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

/** Whether the site is served over https, behind a proxy or not. */
function secure(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return (forwarded ?? new URL(request.url).protocol.replace(':', '')) === 'https'
}

/**
 * Whether a form's post comes from this site: another site could otherwise sign a browser in, or
 * out, behind its owner's back. Browsers say where a post comes from; one that says nothing at
 * all isn't a browser's cross-site form.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  return [
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
    request.headers.get('host'),
    new URL(request.url).host,
  ].includes(host)
}
