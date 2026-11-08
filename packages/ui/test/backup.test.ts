import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/api.ts'
import { readBackupFile } from '../src/backup-file.ts'

const HEADER = {
  format: 'otw-db',
  version: 1,
  createdAt: '2026-11-08T12:00:00.000Z',
  database: 'shop',
  server: 'PostgreSQL 17.5',
  serverVersion: 170005,
  schemas: ['public'],
  roles: [],
  notIncluded: [],
}
const FILE = `-- otw-db backup ${JSON.stringify(HEADER)}\nSET x = 1;\n${'INSERT INTO t VALUES (1);\n'.repeat(5_000)}`

describe('readBackupFile', () => {
  it('reads a gzipped backup’s first line, and no further than it needs', async () => {
    expect(await readBackupFile(new Blob([gzipSync(FILE)]))).toEqual({
      kind: 'sql',
      header: HEADER,
    })
  })

  it('reads a plain one too', async () => {
    expect(await readBackupFile(new Blob([FILE]))).toEqual({ kind: 'sql', header: HEADER })
  })

  it('knows pg_dump’s archive by its signature', async () => {
    expect(await readBackupFile(new Blob(['PGDMP\x01\x0e']))).toEqual({ kind: 'pg_dump' })
  })

  it('says what’s wrong with anything else', async () => {
    expect(await readBackupFile(new Blob(['DROP TABLE users;\n']))).toEqual({
      kind: 'unknown',
      reason:
        'This isn’t a backup made here: choose a .sql.gz from Back up, or a .dump from pg_dump.',
    })
    const gz = gzipSync(FILE)
    expect(await readBackupFile(new Blob([gz.subarray(0, 12)]))).toMatchObject({ kind: 'unknown' })
    expect(await readBackupFile(new Blob(['-- otw-db backup {broken\n']))).toEqual({
      kind: 'unknown',
      reason: 'The backup’s first line is damaged.',
    })
  })
})

describe('api.restore', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the file in the pieces the server asks for, retrying a failed one, then runs it', async () => {
    const calls: { url: string; size?: number }[] = []
    let failures = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body
        calls.push({ url, ...(body instanceof Blob ? { size: body.size } : {}) })
        if (url.endsWith('/restore-start')) {
          return Response.json({ upload: 'u1', chunkBytes: 4 })
        }
        if (url.includes('/restore-chunk')) {
          // The network drops one piece once: it's sent again.
          if (url.includes('seq=1') && failures-- > 0) {
            return Response.json({ error: { code: 'x', message: 'busy' } }, { status: 503 })
          }
          return Response.json({ received: (body as Blob).size })
        }
        return new Response(
          '{"type":"progress","statements":1,"bytes":10}\n{"type":"done","statements":2,"tables":1,"rows":3,"durationMs":5}\n',
        )
      }),
    )
    const api = createApi({ api: '/db/api' }, () => {}, 'archive')
    const sent: number[] = []
    const lines: string[] = []
    const last = await api.restore(
      'main',
      new Blob(['0123456789']),
      'sql',
      (n) => sent.push(n),
      (line) => lines.push(line.type),
    )
    expect(last).toEqual({ type: 'done', statements: 2, tables: 1, rows: 3, durationMs: 5 })
    expect(lines).toEqual(['progress', 'done'])
    expect(sent).toEqual([4, 8, 10])
    expect(calls.map((c) => c.url)).toEqual([
      '/db/api/restore-start',
      '/db/api/restore-chunk?connection=main&upload=u1&seq=0&database=archive',
      '/db/api/restore-chunk?connection=main&upload=u1&seq=1&database=archive',
      '/db/api/restore-chunk?connection=main&upload=u1&seq=1&database=archive',
      '/db/api/restore-chunk?connection=main&upload=u1&seq=2&database=archive',
      '/db/api/restore-run',
    ])
    expect(calls.filter((c) => c.size !== undefined).map((c) => c.size)).toEqual([4, 4, 4, 2])
  })

  it('drops the upload when a piece can’t be sent', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.endsWith('/restore-start')) return Response.json({ upload: 'u1', chunkBytes: 4 })
        if (url.includes('/restore-chunk')) {
          return Response.json(
            { error: { code: 'too-large', message: 'Too big' } },
            { status: 413 },
          )
        }
        return Response.json({ discarded: true })
      }),
    )
    const api = createApi({ api: '/db/api' }, () => {})
    await expect(
      api.restore(
        'main',
        new Blob(['0123456789']),
        'sql',
        () => {},
        () => {},
      ),
    ).rejects.toThrow('Too big')
    expect(urls.at(-1)).toBe('/db/api/restore-discard')
  })
})
