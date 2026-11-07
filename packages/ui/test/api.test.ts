import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/api.ts'

const sent: { url: string; body: unknown }[] = []

function answer(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: init.body === undefined ? undefined : JSON.parse(init.body as string),
      })
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }),
  )
}

afterEach(() => {
  sent.length = 0
  vi.unstubAllGlobals()
})

describe('createApi on another database', () => {
  it('names the database on every call that reads or runs something', async () => {
    answer({ tables: [], info: {}, table: {}, count: 1, rows: [], columns: [] })
    const api = createApi({ api: '/db/api' }, () => {}, 'arena_live')
    await api.tables('main')
    await api.info('main')
    await api.table('main', 'arena', 'matches')
    await api.rows({ connection: 'main', schema: 'arena', table: 'matches', limit: 10, offset: 0 })
    await api.count({ connection: 'main', schema: 'arena', table: 'matches' })
    await api.query('main', 'SELECT 1', 'q1')
    await api.apply({ connection: 'main', schema: 'arena', table: 'matches', changes: [] })
    expect(sent.map((s) => s.url)).toEqual([
      '/db/api/tables?connection=main&database=arena_live',
      '/db/api/info?connection=main&database=arena_live',
      '/db/api/table?connection=main&schema=arena&name=matches&database=arena_live',
      '/db/api/rows',
      '/db/api/count',
      '/db/api/query',
      '/db/api/apply',
    ])
    expect(sent.slice(3).map((s) => (s.body as { database: string }).database)).toEqual(
      Array(4).fill('arena_live'),
    )
  })

  it('lists connections, the server’s databases and cancels without one', async () => {
    answer({ connections: [], current: 'postgres', databases: [], canceled: true })
    const api = createApi({ api: '/db/api' }, () => {}, 'arena_live')
    await api.connections()
    await api.databases('main')
    await api.cancel('q1')
    expect(sent).toEqual([
      { url: '/db/api/connections', body: undefined },
      { url: '/db/api/databases?connection=main', body: undefined },
      { url: '/db/api/cancel', body: { queryId: 'q1' } },
    ])
  })

  it('sends no database for the connection’s own', async () => {
    answer({ tables: [] })
    await createApi({ api: '/db/api' }, () => {}).tables('main')
    expect(sent.map((s) => s.url)).toEqual(['/db/api/tables?connection=main'])
  })
})
