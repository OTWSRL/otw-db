import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { createDbAdmin, type DbAdmin } from '@otwdesign/db-core'
import { startServer, type RunningServer } from '../src/cli.ts'
import { toNodeHandler } from '../src/index.ts'

const url = inject('postgresUrl')
const HEADERS = { 'x-db-admin': '1', authorization: 'Bearer ok' }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

function admin(basePath = '/db'): DbAdmin {
  const created = createDbAdmin({
    basePath,
    connections: [{ name: 'main', url, access: 'read' }],
    authorize: (request) =>
      request.headers.get('authorization') === 'Bearer ok' ? { id: 'ana' } : null,
    audit: false,
  })
  cleanups.push(() => created.close())
  return created
}

async function serve(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const query = (sql: string) => ({
  method: 'POST',
  headers: { ...HEADERS, 'content-type': 'application/json' },
  body: JSON.stringify({ connection: 'main', sql }),
})

describe('toNodeHandler', () => {
  it('serves the API from node:http', async () => {
    const base = await serve(createServer(toNodeHandler(admin())))
    const listed = await fetch(`${base}/db/api/connections`, { headers: HEADERS })
    expect(listed.status).toBe(200)
    expect((await listed.json()).connections[0].name).toBe('main')
    const ran = await fetch(`${base}/db/api/query`, query("SELECT 'hello' AS greeting"))
    expect(await ran.json()).toMatchObject({
      rows: [['hello']],
      columns: [{ name: 'greeting', type: 'text' }],
    })
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
  })

  it('mounts in Express, passing other paths on', async () => {
    const app = express()
    app.use('/db', toNodeHandler(admin()))
    app.get('/', (_req, res) => {
      res.send('the app')
    })
    const base = await serve(createServer(app))
    expect(await (await fetch(`${base}/`)).text()).toBe('the app')
    const ran = await fetch(`${base}/db/api/query`, query('SELECT 2 AS n'))
    expect((await ran.json()).rows).toEqual([['2']])
  })

  it('takes a body express.json() already read', async () => {
    const app = express()
    app.use(express.json())
    app.use(toNodeHandler(admin()))
    const base = await serve(createServer(app))
    const ran = await fetch(`${base}/db/api/query`, query('SELECT 3 AS n'))
    expect((await ran.json()).rows).toEqual([['3']])
  })

  it('mounts at the root with an empty base path', async () => {
    const base = await serve(createServer(toNodeHandler(admin(''))))
    expect((await fetch(`${base}/api/connections`, { headers: HEADERS })).status).toBe(200)
  })

  it('answers with the API’s errors as they are', async () => {
    const base = await serve(createServer(toNodeHandler(admin())))
    const refused = await fetch(`${base}/db/api/connections`, { headers: { 'x-db-admin': '1' } })
    expect(refused.status).toBe(401)
    const failed = await fetch(`${base}/db/api/query`, query('SELEC 1'))
    expect(failed.status).toBe(400)
    expect((await failed.json()).error).toMatchObject({ sqlState: '42601', position: 1 })
  })

  it('cancels the query when the browser goes away', async () => {
    const base = await serve(createServer(toNodeHandler(admin())))
    const leaving = new AbortController()
    const started = fetch(`${base}/db/api/query`, {
      ...query('SELECT pg_sleep(30)'),
      signal: leaving.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    leaving.abort()
    await expect(started).rejects.toThrow()
    // The server stopped the statement: nothing like it is still running.
    const check = () =>
      fetch(
        `${base}/db/api/query`,
        query(
          "SELECT count(*) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30)' AND state = 'active'",
        ),
      )
    await expect
      .poll(async () => (await (await check()).json()).rows, { timeout: 3_000 })
      .toEqual([['0']])
  })
})

describe('otw-db', () => {
  let server: RunningServer
  afterEach(async () => {
    await server?.close()
  })

  it('signs in with the token from its link, and only with it', async () => {
    server = await startServer({ connections: [{ name: 'main', url, access: 'read' }], port: 0 })
    const origin = new URL(server.url).origin
    expect(server.url).toBe(`${origin}/?token=${server.token}`)
    expect(
      (await fetch(`${origin}/api/connections`, { headers: { 'x-db-admin': '1' } })).status,
    ).toBe(401)

    const signIn = await fetch(server.url, { redirect: 'manual' })
    expect(signIn.status).toBe(303)
    expect(signIn.headers.get('location')).toBe('/')
    const cookie = signIn.headers.get('set-cookie')!
    expect(cookie).toMatch(/^otw_db_token=.+; HttpOnly; SameSite=Strict; Path=\/$/)
    const withCookie = await fetch(`${origin}/api/connections`, {
      headers: { 'x-db-admin': '1', cookie: cookie.split(';')[0]! },
    })
    expect(withCookie.status).toBe(200)

    const bearer = await fetch(`${origin}/api/connections`, {
      headers: { 'x-db-admin': '1', authorization: `Bearer ${server.token}` },
    })
    expect(bearer.status).toBe(200)

    const wrong = await fetch(`${origin}/?token=guess`, { redirect: 'manual' })
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  it('listens on this machine only, unless told otherwise', async () => {
    server = await startServer({ connections: [], port: 0 })
    expect(new URL(server.url).hostname).toBe('127.0.0.1')
  })
})
