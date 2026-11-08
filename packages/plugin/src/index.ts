import { definePlugin, type ApiContext, type PluginContext } from '@otwdesign/sdk'
import type { ConnectionConfig, DbAdmin, PGliteLike, PostgresOptions } from '@otwdesign/db-core'
import { ROUTES } from '@otwdesign/db-core/routes'

declare module '@otwdesign/sdk' {
  interface Capabilities {
    /** Open the Database screen: browse, query and edit the site's database. Administrators have it. */
    'db.manage': true
  }
}

/** The site's own database's connection, always listed first. */
export const SITE = 'site'

/** What a heavy statement does to a site whose database runs in its own process. */
export const EMBEDDED_WARNING =
  "This is the site's embedded database: it runs inside the site, so a heavy statement holds the whole site until it finishes, and nothing can stop it early."

const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJibGFjayIgc3Ryb2tlLXdpZHRoPSIxLjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMgNGMwLTEuMSAyLjItMS41IDUtMS41czUgLjQgNSAxLjV2OGMwIDEuMS0yLjIgMS41LTUgMS41cy01LS40LTUtMS41eiBNMyA0YzAgMS4xIDIuMiAxLjUgNSAxLjVzNS0uNCA1LTEuNSBNMyA4YzAgMS4xIDIuMiAxLjUgNSAxLjVzNS0uNCA1LTEuNSIvPjwvc3ZnPg=='

/**
 * The site's database: PostgreSQL at DATABASE_URL, or the embedded PGlite the site has open (one
 * process may open it, so the tool uses the site's own instance). Read-only unless
 * DB_ADMIN_SITE_ACCESS says write.
 */
export function siteConnection(env: NodeJS.ProcessEnv = process.env): ConnectionConfig {
  const url = env.DATABASE_URL?.trim()
  return {
    name: SITE,
    label: 'This site',
    // The embedded database is reached through the site, not an address; this one names its kind.
    url: url || 'postgres://embedded.site/',
    access: env.DB_ADMIN_SITE_ACCESS?.trim() === 'write' ? 'write' : 'read',
    ...(url ? {} : { warning: EMBEDDED_WARNING }),
  }
}

/**
 * pg and pg-cursor from the plugin's own dependencies, imported on the first PostgreSQL
 * connection. The site's bundler resolves these imports from the plugin. db-core's own imports are
 * resolved from where the site's bundle runs, which under pnpm has neither: pnpm keeps them beside
 * the plugin, not in the site's root.
 */
const postgres: PostgresOptions = {
  modules: () => Promise.all([import('pg'), import('pg-cursor')]),
}

/**
 * Registers the tool's API under /api/p/db from its static route table. The tool itself (its
 * engine, drivers and browser app) loads on the first request to it, so a site that never opens
 * the Database screen never loads it, and boots as fast as without the plugin.
 */
export function setup(cms: PluginContext): void {
  cms.auth.capability('db.manage', { label: 'Manage databases' })
  // The CMS's API context, for authorize(): who signed in, through the site's own session.
  const contexts = new WeakMap<Request, ApiContext>()
  let admin: Promise<DbAdmin> | undefined
  const tool = () =>
    (admin ??= import('@otwdesign/db-core').then((core) => {
      const site = siteConnection()
      return core.createDbAdmin({
        basePath: cms.routes.apiUrl('/'),
        connections: [site, ...core.connectionsFromEnv().filter((c) => c.name !== SITE)],
        async authorize(request) {
          const user = await contexts.get(request)?.user()
          return user && cms.auth.can(user, 'db.manage') ? { id: user.email } : null
        },
        driver(connection) {
          if (connection.name !== SITE) return core.openDriver(connection, { postgres })
          return site.warning
            ? core.pgliteDriver((cms.db as unknown as { $client: PGliteLike }).$client)
            : core.postgresDriver(connection.url, postgres)
        },
        signInUrl: '/admin',
      })
    }))
  for (const { method, path } of ROUTES) {
    cms.routes.api({
      method,
      path,
      async handler(request, context) {
        contexts.set(request, context)
        return (await tool()).fetch(request)
      },
    })
  }
}

export default definePlugin({
  id: 'db',
  version: '1.3.0',
  name: 'Database',
  icon: ICON,
  description:
    "Browse, query and edit the site's database, and any other you connect, the way TablePlus does.",
  requires: { core: '^1.1.0' },
  setup,
})
