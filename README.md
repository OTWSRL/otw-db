# OTW DB

A database manager in your app: browse, query and edit PostgreSQL, MySQL, MariaDB and SQLite from an OTW CMS site, any Next.js app, any Node server, or on its own. Apache-2.0.

> Work in progress: the engine, its API and the browser app, with editing and export, for
> PostgreSQL, MySQL, MariaDB and SQLite. The hosts (Next.js examples, the CMS plugin) are next. See
> [docs/plan.md](docs/plan.md).

| Package              | For                                                          |
| -------------------- | ------------------------------------------------------------ |
| `@otwdesign/db-core` | The engine and its API, as one standard Fetch handler        |
| `@otwdesign/db-next` | Next.js: `npx @otwdesign/db-next init`, with its own sign-in |
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
  shows their SQL and commits them in one transaction: all or nothing, and nothing when a cell you
  edited was changed by someone else meanwhile, or its row is gone. ⌘Z steps back; Discard drops
  them.
- **Export:** a table (with its filters and order) as CSV, JSON or SQL INSERTs, streamed from the
  server; a query's result as CSV or JSON. The INSERTs put the rows back as they were: bytes as
  bytes, the keys the rows had, the columns the database computes left to it, in strings that read
  the same whatever the session they're run in is set to.
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

A read-only transaction stops changes to rows, and nothing else: a login that may write the
server's files, run programs on it or change its settings (a PostgreSQL superuser, MySQL's
`root`) still could through a connection marked `read`. So of someone's own SQL, read access
runs only the statements that read, by their first word: `SELECT`, `WITH`, `VALUES`, `TABLE`,
`SHOW` and `EXPLAIN` (and `DESCRIBE` on MySQL). Anything else is refused before it reaches the
database, `COPY`, `DO`, `SET`, `CALL` and `KILL` among it. Within those, the functions known to
reach past the database's rows are refused by name (`pg_read_file`, `lo_export`,
`pg_terminate_backend`, `set_config`, `dblink`, `query_to_xml` and the like; `LOAD_FILE` and
`INTO OUTFILE` on MySQL), and so is a statement that only mentions one. It's a guard, not a
wall: no list has every function, and one the database's owner wrote can do what its owner
may. A read connection is safe with a login that may only read.

SQLite has no roles: there the file is the boundary, and the tool keeps to it. Each statement runs
on a handle of its own, closed after it, so nothing it sets up (a transaction left open, a TEMP
view named as a table is, a PRAGMA) reaches the next person's statement, the grid's edits or the
app the file belongs to. `ATTACH` and `VACUUM INTO`, which reach other files on the server, are
refused, and so is a `BEGIN` that nothing would ever commit. So are the PRAGMAs that set a limit
for every SQLite file the server has open (`hard_heap_limit`, `soft_heap_limit`,
`temp_store_directory`, `data_store_directory`); reading them, and every other PRAGMA, is as it
was. Someone's own SQL runs in a process of its own (about 40 MB), started with the first
statement and let go of after a minute's rest: a statement past its time limit is killed with
it, where a thread could only be asked to stop, and so is one still running when the server
itself goes. A write killed that way is undone before the grid's next read. Where the server
can't start a process, it runs on a thread, as before.

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
  typed tables, tables that inherit another, event triggers…) is listed before you download and
  in the file, never left out unsaid; so is a foreign key from a table it holds to one it can't,
  and a sequence the login may not read. Nothing of a table it can't hold is in the file: not its
  keys, indexes, triggers or the sequences its columns own. psql restores it too:
  `gunzip -c backup.sql.gz | psql --single-transaction -v ON_ERROR_STOP=1 -d <url>`.
- **pg_dump** (`.dump`), where the server running the tool has `pg_dump`, as new as the
  database: a VPS, or a container with the PostgreSQL client. Not on Vercel, or for the embedded
  database.

**Restore** needs a `write` connection. It shows what the file holds and what it replaces, and
asks you to type the database's name, which the server checks too. Then:

- It replaces the schemas the backup holds: what they hold is dropped and made again from the
  file. The schema itself, its owner and its privileges stay. Other schemas aren't touched, and
  if anything in them depends on what's replaced (a view on one of its tables, say), the restore
  says what and refuses.
- What a backup can't hold stays where it is: a foreign table, an aggregate, an operator. Where
  one of those needs something the restore replaces (a table that inherits a replaced one, an
  aggregate on a replaced function, a server on an extension of the schema), dropping that would
  take it too, and no backup would bring it back: the restore says what, and refuses, until you
  remove it yourself.
- When something is using a table the restore replaces, it waits 10 seconds, then says the
  database is busy. The upload stays (a day at most): Try again runs it without sending the file
  a second time.
- It runs in one transaction: if anything fails, or the file was cut short (every backup ends
  with a line saying it's whole), nothing changes. A file that holds what would end that
  transaction (`COMMIT`, `BEGIN`, `ROLLBACK`…) or a `COPY` was changed after it was made, and is
  refused. Beyond that, a restore runs the SQL its file holds, as the connection's login: restore
  the backups you made, or trust. The audit log has the file's SHA-256 and how many statements ran.
- Owners and grants that name a role this server lacks are skipped, and listed first. A policy
  is made for those of its roles the server has, so what it allowed them, or kept from them, still
  holds; with none of them here, it's skipped. Roles aren't in a backup.
- What's restored has the privileges the backup holds, whatever this server's default privileges
  (`ALTER DEFAULT PRIVILEGES`, as hosted servers set for their API roles) would add to it: a
  function the backup had revoked from everyone doesn't come back callable.
- Generated columns are computed again by the restoring server, as with pg_dump: one that calls
  `lower()` on non-English letters, say, follows that server's locale.
- Extensions the schemas use are made where they were. The database's other extensions are made
  too where this server has them, and skipped where it hasn't: a function's body may call one,
  and PostgreSQL keeps no record of what a body calls.
- The browser sends the file in 4 MB pieces, which wait in the database itself (a schema named
  `otw_db_restore`, gone afterwards): Vercel takes 4.5 MB a request, and serverless instances
  share nothing else. A restore is 1 GB at most by default (`backups.maxRestoreBytes`). That
  schema must be the connection's login's own: one another role made, which could read the pieces
  or change them, is refused, and the restore says to drop it.
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

**Next.js**, on Vercel or anywhere: in the app's directory,

```sh
npx @otwdesign/db-next init
```

It writes one route file and installs `@otwdesign/db-next`. The password is yours to choose: set
`DB_ADMIN_PASSWORD` (16 characters or more) in `.env.local` and in your host's settings.
[examples/next](examples/next) is the app it leaves, with its tests.

```ts
// app/db/[[...path]]/route.ts
import { createDbRoute } from '@otwdesign/db-next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const { GET, POST } = createDbRoute()
```

```dotenv
DB_ADMIN_PASSWORD=…                              # whoever has it gets in; 16 characters at least
DB_ADMIN_USERS=you@example.com,ana@example.com   # the app's signed-in users who need no password
DB_ADMIN_MAIN_URL=postgres://…                   # or the app's own DATABASE_URL, read-only
```

- **Who gets in.** `/db` has a sign-in page of its own, for the password. The app's own users
  listed in `DB_ADMIN_USERS` get in without it once they're signed in to the app, and the audit
  log has their email. With the list set and no password, only they get in. An app on Supabase
  Auth has its session read, with no code; any other sign-in says who is signed in:
  `createDbRoute({ user: async () => (await auth())?.user?.email })`. Or decide it all yourself
  with `createDbRoute({ authorize })`.
- **Which databases.** `DB_ADMIN_<NAME>_URL`, as everywhere. With none, the app's own, read-only
  (`DB_ADMIN_APP_ACCESS=write` to edit): `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`,
  `DATABASE_URL` or `POSTGRES_URL`, in that order, since the tool keeps a session and a
  transaction pooler doesn't.
- **Supabase.** Linked through Vercel's integration, the database's address is in the env
  already. An app that only uses Supabase's API has none: copy the Session pooler connection
  string from Supabase's Connect dialog into `DB_ADMIN_MAIN_URL`. List in `DB_ADMIN_USERS` only
  people who have an account, and keep Confirm email on: an address nobody has registered could
  otherwise be signed up by anyone.
- **Middleware** that signs people in on every route must leave `/db` out of its matcher: the
  tool's API can't be answered with a login page.
- **On Vercel** the package brings `pg` and `pg-cursor` itself, where Next's file tracing finds
  them. Mounting `createDbAdmin` by hand, hand them over the same way (see [Drivers](#drivers)),
  or the deployed function has no driver. MySQL and MariaDB work where the whole of
  `node_modules` is deployed (`next start` on a server), not yet in a Vercel function.

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
so; a query's rows are read through a cursor, so only those shown are built in the site's memory.
The connection is the site's own: after a statement or a restore, what it set on the session
(`SET`, a role, temporary tables, locks) is undone, and what the site set is left as it was. The
plugin registers four routes at boot (about 0.2 ms) and loads the tool on the first request to
it. It brings `pg` and `pg-cursor` itself, with npm or pnpm; MySQL and MariaDB connections need
`mysql2` installed in the site.

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

A PostgreSQL connection has a pool of three. A request that finds them all held for 10 seconds
fails and says so, rather than wait (`connectTimeoutMs`, an option of `postgresDriver`). A MySQL
statement past its time limit is stopped with `KILL QUERY`; where that can't reach it (a proxy,
a server at its connection limit), its connection is closed two seconds later instead.

An export nobody reads for 5 minutes is ended (`exportIdleMs`, an option of `postgresDriver`,
`sqliteDriver` and `pgliteDriver`), so it doesn't hold a connection, a lock or a file for as long
as a browser stays away. Each driver exports a table a batch at a time, whatever its size: SQLite
on a thread of the export's own, PGlite from rows the database keeps aside, so the site's own
queries go on between batches. On MySQL and MariaDB an export's time limit is on the server
sending nothing: a table that keeps coming may take as long as it takes.

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
