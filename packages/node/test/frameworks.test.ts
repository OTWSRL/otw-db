import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import Fastify from 'fastify'
import { Hono } from 'hono'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { createDbAdmin, type DbAdmin } from '@otwdesign/db-core'
import { fastifyPlugin, koaMiddleware } from '../src/index.ts'

const HEADERS = { 'x-db-admin': '1', 'content-type': 'application/json' }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

function admin(): DbAdmin {
  const created = createDbAdmin({
    basePath: '/db',
    connections: [{ name: 'main', url: inject('postgresUrl'), access: 'read' }],
    authorize: () => ({ id: 'ana' }),
    audit: false,
    ui: false,
  })
  cleanups.push(() => created.close())
  return created
}

/** The checks every host must pass: the API, a body intact, and its own routes untouched. */
async function exercise(base: string) {
  const listed = await fetch(`${base}/db/api/connections`, { headers: HEADERS })
  expect(listed.status).toBe(200)
  expect((await listed.json()).connections[0].name).toBe('main')
  const ran = await fetch(`${base}/db/api/query`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ connection: 'main', sql: "SELECT 'from the body' AS said" }),
  })
  expect(await ran.json()).toMatchObject({ rows: [['from the body']] })
  expect(await (await fetch(`${base}/`)).text()).toBe('the app')
}

describe('in a framework', () => {
  it('runs in Fastify, beside routes whose bodies Fastify parses', async () => {
    const app = Fastify()
    app.get('/', async () => 'the app')
    app.post('/echo', async (request) => request.body)
    await app.register(fastifyPlugin(admin()))
    await app.listen({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => app.close())
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    await exercise(base)
    // The plugin's parser settings stayed inside it.
    const echoed = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: HEADERS,
      body: '{"a":1}',
    })
    expect(await echoed.json()).toEqual({ a: 1 })
  })

  it('runs in Koa, after a body parser', async () => {
    const app = new Koa()
    app.use(bodyParser())
    app.use(koaMiddleware(admin()))
    app.use((ctx) => {
      ctx.body = 'the app'
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    cleanups.push(() => new Promise((resolve) => server.close(resolve)))
    await exercise(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  })

  it('runs in Hono, which takes the Fetch handler as it is', async () => {
    const dbAdmin = admin()
    const app = new Hono()
    app.get('/', (c) => c.text('the app'))
    app.all('/db/*', (c) => dbAdmin.fetch(c.req.raw))
    const base = await new Promise<string>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve(`http://127.0.0.1:${info.port}`),
      )
      cleanups.push(() => new Promise((done) => server.close(done)))
    })
    await exercise(base)
  })
})
