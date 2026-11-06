# @otwdesign/db-core

OTW DB's engine and HTTP API, as one standard Fetch handler: browse, query and edit PostgreSQL,
MySQL, MariaDB and SQLite from any app. Next.js route handlers, Hono, Bun and Deno take the
handler as it is; Node servers mount it with `@otwdesign/db-node`.

```sh
npm install @otwdesign/db-core pg pg-cursor   # mysql2 for MySQL and MariaDB; SQLite needs nothing
```

```ts
import { connectionsFromEnv, createDbAdmin } from '@otwdesign/db-core'

export const dbAdmin = createDbAdmin({
  basePath: '/db',
  connections: connectionsFromEnv(), // DB_ADMIN_<NAME>_URL, _ACCESS, _LABEL, _TAG
  authorize: async (request) => ((await isAdmin(request)) ? { id: 'you' } : null),
})
```

The whole guide: [github.com/OTWSRL/otw-db](https://github.com/OTWSRL/otw-db#readme).
