# @otwdesign/db-node

OTW DB in Node servers: node:http, Express, Connect, Fastify and Koa.

```sh
npm install @otwdesign/db-node @otwdesign/db-core pg pg-cursor
```

```ts
import { fastifyPlugin, koaMiddleware, toNodeHandler } from '@otwdesign/db-node'

app.use('/db', toNodeHandler(dbAdmin)) // Express or Connect
http.createServer(toNodeHandler(dbAdmin)) // node:http
await fastify.register(fastifyPlugin(dbAdmin)) // Fastify
koa.use(koaMiddleware(dbAdmin)) // Koa
```

`dbAdmin` comes from `createDbAdmin()` in `@otwdesign/db-core`. The whole guide:
[github.com/OTWSRL/otw-db](https://github.com/OTWSRL/otw-db#readme).
