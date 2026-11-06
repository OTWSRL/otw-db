# OTW DB

A database manager in your app: browse, query and inspect PostgreSQL (MySQL/MariaDB and SQLite
are next) from an OTW CMS site, any Next.js app, any Node server, or on its own. Apache-2.0.

> Work in progress: the engine, its API and the browser app, with editing and export, are here;
> MySQL/MariaDB and SQLite are next. See [docs/plan.md](docs/plan.md).

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
- **Shortcuts:** ⌘P open a table, ⌘E new SQL editor, ⌘R refresh, ⌘F filter, ⌥W close the tab (a
  browser keeps ⌘W), ⌘[ and ⌘] switch tabs. Ctrl instead of ⌘ off a Mac.
- Light and dark, following the system. Tabs and history are kept per connection in the browser.

## Connections

From the environment, or a list in code. URLs stay on the server; the browser names connections only.

```dotenv
DB_ADMIN_MAIN_URL=postgres://reader:secret@db.example.com:5432/shop
DB_ADMIN_MAIN_ACCESS=read        # or write
DB_ADMIN_MAIN_LABEL=Shop
DB_ADMIN_MAIN_TAG=production     # local, development, testing, staging, production
```

`read` runs every query in a read-only transaction. The database role is still the real boundary:
give read connections a role that may only `SELECT`.

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

```ts
import { dbAdmin } from '@/db-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = dbAdmin.fetch
export const POST = dbAdmin.fetch
```

**Hono, Bun, Deno:** `app.all('/db/*', (c) => dbAdmin.fetch(c.req.raw))`, or `Bun.serve({ fetch: dbAdmin.fetch })`.

**node:http, Express, Connect:**

```ts
import { toNodeHandler } from '@otwdesign/db-node'

app.use('/db', toNodeHandler(dbAdmin)) // Express or Connect
http.createServer(toNodeHandler(dbAdmin)) // node:http
```

It works after `express.json()` too. CommonJS apps `require()` it as well (Node 22.12+).

Koa and Fastify come with milestone 5, with tests of their own.

**Routers that register paths one by one** (the OTW CMS's): `dbAdmin.routes` lists every endpoint
with a fixed path.

## On its own

```sh
DB_ADMIN_MAIN_URL=postgres://… npx @otwdesign/db
```

It listens on 127.0.0.1:4010 and prints a link with a one-time token, which signs your browser in.

## Drivers

Install the ones you use; nothing else is loaded.

| Database   | Install              |
| ---------- | -------------------- |
| PostgreSQL | `pg` and `pg-cursor` |

## Development

```sh
pnpm install
pnpm check      # lint, format, types, tests; the tests start PostgreSQL in Docker
pnpm build
pnpm test:e2e   # the app in Chromium against PostgreSQL in Docker (E2E_POSTGRES_URL for your own)
```

Set `TEST_POSTGRES_URL` to test against a server of your own instead of Docker.
