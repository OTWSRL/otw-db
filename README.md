# OTW DB

A database manager in your app: browse, query and edit PostgreSQL, MySQL, MariaDB and SQLite from an OTW CMS site, any Next.js app, any Node server, or on its own. Apache-2.0.

> Work in progress: the engine, its API and the browser app, with editing and export, for
> PostgreSQL, MySQL, MariaDB and SQLite. The hosts (Next.js examples, the CMS plugin) are next. See
> [docs/plan.md](docs/plan.md).

| Package              | For                                                          |
| -------------------- | ------------------------------------------------------------ |
| `@otwdesign/db-core` | The engine and its API, as one standard Fetch handler        |
| `@otwdesign/db-node` | node:http, Express and Connect                               |
| `@otwdesign/db`      | The `otw-db` command, with every driver: `npx @otwdesign/db` |

## The app

It works the way TablePlus does, with its own look: a connection list in environment colors, then
a window with the schema's tables in a sidebar, tabs for tables and SQL editors, and a console.

- **Tables:** pages of rows in a fast grid (sort by a header, resize, arrow keys, ⌘C), a filter bar
  with TablePlus's operators, exact counts on demand, the Structure view, and the selected row whole
  in the right-hand panel.
- **Editing**, on a write connection, in tables with a primary key: double-click, Enter or type to
  edit a cell (⌘⌫ sets NULL), "+ Row" to add, Delete to remove. Edits are staged in color until ⌘S
  shows their SQL and commits them in one transaction: all or nothing, and nothing when a row
  changed meanwhile. ⌘Z steps back; Discard drops them.
- **Export:** a table (with its filters and order) as CSV, JSON or SQL INSERTs, streamed from the
  server; a query's result as CSV or JSON.
- **SQL editor:** completion of tables; ⌘↵ runs the statement at the cursor, ⇧⌘↵ them all, each
  with its own result; errors point at their line and column; Cancel stops the query on the server.
  Writes on a `production` connection ask first.
- **Databases:** a PostgreSQL connection opens any of its server's databases its login may connect
  to. Click the database's name in the toolbar, or ⌘K, and type a few letters of another.
- **Backups:** the toolbar's Back up and restore downloads a PostgreSQL database's schemas as a
  `.sql.gz`, and restores one, on any host, Vercel included. Where the server has `pg_dump`, it can
  make pg_dump's `.dump` too. See [Backups](#backups).
- **Shortcuts:** ⌘P open a table, ⌘K open another database, ⌘E new SQL editor, ⌘R refresh, ⌘F
  filter, ⌥W close the tab (a browser keeps ⌘W), ⌘[ and ⌘] switch tabs. Ctrl instead of ⌘ off a
  Mac.
- Light and dark, following the system. Tabs and history are kept per connection and database in
  the browser, and the address names both, so a reload comes back to them.

## Connections

From the environment, or a list in code. URLs stay on the server; the browser names connections only.

```dotenv
DB_ADMIN_MAIN_URL=postgres://reader:secret@db.example.com:5432/shop
DB_ADMIN_MAIN_ACCESS=read        # or write
DB_ADMIN_MAIN_LABEL=Shop
DB_ADMIN_MAIN_TAG=production     # local, development, testing, staging, production
DB_ADMIN_MAIN_DATABASES=one      # or all, the default
```

`read` runs every query in a read-only transaction. The database role is still the real boundary:
give read connections a role that may only `SELECT`.

A PostgreSQL connection opens one database at a time, the URL's first. Its login may connect to
others on the same server, as a superuser can to all, and the tool lists those: every database
but the templates and those the login has no `CONNECT` on. Each opens with the same login, access
and tag, on a pool of its own that opens on first use; the eight used last stay open.
`DATABASES=one` pins a connection to the URL's database, for a login with more privileges than the
tool should show. MySQL needs none of this: its databases are the schemas of one connection.

## Backups

The toolbar's **Back up and restore** (PostgreSQL connections, the CMS's embedded database
included) does both from the browser.

**Back up** saves the schemas you tick, those the login owns at first:

- **SQL backup** (`.sql.gz`), always. The tool writes it from the catalog in one read-only
  snapshot: schemas, extensions, types and domains, sequences and where they had got to,
  tables with their rows, keys, indexes, foreign keys, views and materialized views, functions
  and procedures, triggers and rules, row-level security and policies, statistics, comments,
  owners and privileges. What it can't hold (aggregates, operators, C functions, foreign tables,
  table inheritance, event triggers…) is listed before you download and in the file, never left
  out unsaid. psql restores it too:
  `gunzip -c backup.sql.gz | psql --single-transaction -v ON_ERROR_STOP=1 -d <url>`.
- **pg_dump** (`.dump`), where the server running the tool has `pg_dump`, as new as the
  database: a VPS, or a container with the PostgreSQL client. Not on Vercel, or for the embedded
  database.

**Restore** needs a `write` connection. It shows what the file holds and what it replaces, and
asks you to type the database's name. Then:

- It replaces the schemas the backup holds: what they hold is dropped and made again from the
  file. The schema itself, its owner and its privileges stay. Other schemas aren't touched, and
  if anything in them depends on what's replaced (a view on one of its tables, say), the restore
  says what and refuses.
- It runs in one transaction: if anything fails, or the file was cut short (every backup ends
  with a line saying it's whole), nothing changes.
- Owners, grants and policies that name a role this server lacks are skipped, and listed first.
  Roles aren't in a backup.
- Generated columns are computed again by the restoring server, as with pg_dump: one that calls
  `lower()` on non-English letters, say, follows that server's locale.
- Extensions the schemas use are made where they were. The database's other extensions are made
  too where this server has them, and skipped where it hasn't: a function's body may call one,
  and PostgreSQL keeps no record of what a body calls.
- The browser sends the file in 4 MB pieces, which wait in the database itself (a schema named
  `otw_db_restore`, gone afterwards): Vercel takes 4.5 MB a request, and serverless instances
  share nothing else. A restore is 1 GB at most by default (`backups.maxRestoreBytes`).
- A `.dump` is restored with `pg_restore --clean --if-exists --single-transaction --no-owner`,
  where the server has it.

Both run in a request, so a host's time limit is theirs: Vercel stops a function after 300 seconds
by default, 800 on Pro. For a database of gigabytes, use pg_dump on a machine of your own, or your
host's backups. On the CMS's embedded database, the site waits while either runs; restart a site
after restoring its database, so it reads it again.

## Mounting it

`authorize(request)` is required: return who is asking, or `null`. Use your app's own sign-in.

```ts
import { connectionsFromEnv, createDbAdmin } from '@otwdesign/db-core'

export const dbAdmin = createDbAdmin({
  basePath: '/db',
  connections: connectionsFromEnv(),
  authorize: async (request) => {
    const user = await currentUser(request) // your app's session
    return user?.isAdmin ? { id: user.email } : null
  },
})
```

**Next.js** (`app/db/[[...path]]/route.ts`): a route handler takes the Fetch handler as it is.
[examples/next](examples/next) is a whole app, with its tests.

```ts
import { dbAdmin } from '@/db-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = (request: Request) => dbAdmin.fetch(request)
export const POST = (request: Request) => dbAdmin.fetch(request)
```

**Hono, Bun, Deno:** `app.all('/db/*', (c) => dbAdmin.fetch(c.req.raw))`, or
`Bun.serve({ fetch: dbAdmin.fetch })`.

**node:http, Express, Connect, Fastify, Koa** (`@otwdesign/db-node`):

```ts
import { fastifyPlugin, koaMiddleware, toNodeHandler } from '@otwdesign/db-node'

app.use('/db', toNodeHandler(dbAdmin)) // Express or Connect, after express.json() too
http.createServer(toNodeHandler(dbAdmin)) // node:http
await fastify.register(fastifyPlugin(dbAdmin)) // Fastify; its other routes keep their parsers
koa.use(koaMiddleware(dbAdmin)) // Koa, after koa-bodyparser too
```

Each is tested with a real server. CommonJS apps `require()` it too (Node 22.12+). Bundlers leave
the drivers to the host: a Next.js site builds without the ones it doesn't install.

**OTW CMS:** install `@otwdesign/plugin-db` like any plugin. Database appears in the admin for
administrators (the `db.manage` capability), on the site's own database (read-only unless
`DB_ADMIN_SITE_ACCESS=write`) and any `DB_ADMIN_<NAME>_URL` connections. On a site's embedded
database (PGlite), a heavy statement holds the whole site until it finishes, and the tool says
so. The plugin registers four routes at boot (about 0.2 ms) and loads the tool on the first
request to it. It brings `pg` and `pg-cursor` itself, with npm or pnpm; MySQL and MariaDB
connections need `mysql2` installed in the site.

**Routers that register paths one by one:** `dbAdmin.routes`, or `ROUTES` from
`@otwdesign/db-core/routes` to register at boot without loading the tool: four patterns.

## On its own

```sh
DB_ADMIN_MAIN_URL=postgres://… npx @otwdesign/db
```

It listens on 127.0.0.1:4010 and prints a link with a one-time token, which signs your browser in.

## Drivers

Install the ones you use; nothing else is loaded.

| Database                         | Install                                                   |
| -------------------------------- | --------------------------------------------------------- |
| PostgreSQL (and compatible ones) | `pg` and `pg-cursor`                                      |
| MySQL and MariaDB                | `mysql2`                                                  |
| SQLite                           | nothing: Node's own `node:sqlite`, on a thread of its own |

Addresses: `postgres://…`, `mysql://…` or `mariadb://…`, and `sqlite:/path/to/file.db` (or
`sqlite:./relative.db`; the file must exist).

A driver that opens one database at a time offers the server's others with `databases()`, which
lists them, and `withDatabase(name)`, which returns a driver for one; the PostgreSQL driver has
both. Backups need `session(mode)`, one transaction on a connection of its own, which the
PostgreSQL and PGlite drivers have; `pgUrl` is where pg_dump connects, a server's only.

A driver is imported where the app runs, so from the app's own dependencies. A package that
brings `pg` and `pg-cursor` as its own dependencies and is bundled into an app, as the CMS plugin
is, hands its imports over instead. Under pnpm they sit beside that package, not in the app's
root, and only the app's bundler finds them there:

```ts
import { openDriver, type PostgresOptions } from '@otwdesign/db-core'

const postgres: PostgresOptions = {
  modules: () => Promise.all([import('pg'), import('pg-cursor')]),
}
createDbAdmin({ ...options, driver: (connection) => openDriver(connection, { postgres }) })
```

## Development

```sh
pnpm install
pnpm check      # lint, format, types, tests; the tests start PostgreSQL in Docker
pnpm build
pnpm test:e2e   # the app in Chromium against PostgreSQL in Docker (E2E_POSTGRES_URL for your own)
pnpm packed     # the packages packed as npm would publish them, installed into fresh apps and run
pnpm test:all   # everything CI runs: check, e2e, packed
```

Set `TEST_POSTGRES_URL`, `TEST_MYSQL_URL` and `TEST_MARIADB_URL` to test against servers of your own
instead of Docker. Every driver passes the same conformance suite (`packages/core/test/conformance.ts`).
