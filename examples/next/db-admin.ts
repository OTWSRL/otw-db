import { connectionsFromEnv, createDbAdmin } from '@otwdesign/db-core'

/** The sign-in this example stands in for: a cookie set by /login. Use your app's own. */
export const SESSION = 'demo-session'

/**
 * OTW DB at /db: connections from DB_ADMIN_<NAME>_URL, and whoever holds the session cookie.
 * In your app, authorize() reads your sign-in (Auth.js, Clerk, your own) and checks the role.
 */
export const dbAdmin = createDbAdmin({
  basePath: '/db',
  connections: connectionsFromEnv(),
  authorize(request) {
    const cookie = request.headers.get('cookie') ?? ''
    const session = /(?:^|;\s*)demo-session=([^;]+)/.exec(cookie)?.[1]
    return session && session === process.env.DEMO_SECRET ? { id: 'demo' } : null
  },
  signInUrl: '/login',
})
