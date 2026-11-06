# OTW DB

A database manager in your app: browse, query and inspect PostgreSQL (MySQL/MariaDB and SQLite
are next) from an OTW CMS site, any Next.js app, any Node server, or on its own. Apache-2.0.

> Work in progress. The engine and its HTTP API are here; the browser UI is milestone 2. See
> [docs/plan.md](docs/plan.md).

| Package              | For                                                          |
| -------------------- | ------------------------------------------------------------ |
| `@otwdesign/db-core` | The engine and its API, as one standard Fetch handler        |
| `@otwdesign/db-node` | node:http, Express and Connect                               |
| `@otwdesign/db`      | The `otw-db` command, with every driver: `npx @otwdesign/db` |

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
pnpm check   # lint, format, types, tests; the tests start PostgreSQL in Docker
pnpm build
```

Set `TEST_POSTGRES_URL` to test against a server of your own instead of Docker.
