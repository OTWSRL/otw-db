import { describe, expect, it, vi } from 'vitest'
import {
  exportStream,
  literalPostgres,
  quotePostgres,
  type ExportBatch,
  type ExportFormat,
} from '../src/index.ts'

const dialect = { identifier: quotePostgres, literal: literalPostgres }
const target = { schema: 'public', table: 'posts' }

async function* batches(...list: ExportBatch[]) {
  yield* list
}

async function render(format: ExportFormat, ...list: ExportBatch[]) {
  const done = vi.fn()
  const text = await new Response(
    exportStream(format, batches(...list), target, dialect, done),
  ).text()
  return { text, done }
}

const columns = [{ name: 'id' }, { name: 'title' }]

describe('exportStream', () => {
  it('writes CSV with a header, quoting only what needs it, NULL empty and "" an empty string', async () => {
    const { text, done } = await render(
      'csv',
      {
        columns,
        rows: [
          ['1', 'plain'],
          ['2', 'a, "quoted"\nline'],
        ],
      },
      {
        columns,
        rows: [
          ['3', null],
          ['4', ''],
          ['5', ' padded'],
        ],
      },
    )
    expect(text).toBe(
      'id,title\r\n1,plain\r\n2,"a, ""quoted""\nline"\r\n3,\r\n4,""\r\n5," padded"\r\n',
    )
    expect(done).toHaveBeenCalledWith(5)
  })

  it('writes JSON: an array of objects, values as the database wrote them', async () => {
    const { text } = await render(
      'json',
      { columns, rows: [['1', 'a']] },
      { columns, rows: [['2', null]] },
    )
    expect(JSON.parse(text)).toEqual([
      { id: '1', title: 'a' },
      { id: '2', title: null },
    ])
  })

  it('writes SQL: an INSERT a row, quoted for the database', async () => {
    const { text } = await render('sql', {
      columns,
      rows: [
        ['1', "it's"],
        ['2', null],
      ],
    })
    expect(text).toBe(
      `INSERT INTO "public"."posts" ("id", "title") VALUES ('1', 'it''s');\nINSERT INTO "public"."posts" ("id", "title") VALUES ('2', NULL);\n`,
    )
  })

  it('writes a table with no rows as its header, or an empty array', async () => {
    expect((await render('csv', { columns, rows: [] })).text).toBe('id,title\r\n')
    expect(JSON.parse((await render('json', { columns, rows: [] })).text)).toEqual([])
    expect(JSON.parse((await render('json')).text)).toEqual([])
  })

  it('reports how far it got when the rows stop coming', async () => {
    async function* failing() {
      yield { columns, rows: [['1', 'a']] }
      throw new Error('connection lost')
    }
    const done = vi.fn()
    await expect(
      new Response(exportStream('csv', failing(), target, dialect, done)).text(),
    ).rejects.toThrow()
    expect(done).toHaveBeenCalledWith(1, expect.objectContaining({ message: 'connection lost' }))
  })

  it('stops the driver when the browser stops reading', async () => {
    const stopped = vi.fn()
    async function* endless() {
      try {
        for (;;) yield { columns, rows: [['1', 'a']] }
      } finally {
        stopped()
      }
    }
    const reader = exportStream('csv', endless(), target, dialect, () => {}).getReader()
    await reader.read()
    await reader.cancel()
    expect(stopped).toHaveBeenCalled()
  })
})
