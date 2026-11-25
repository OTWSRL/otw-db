import { jsonObject } from '../src/format.ts'
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

  it('writes SQL that puts rows back: bytes as bytes, no computed columns, keys kept', async () => {
    const done = vi.fn()
    const mysql = {
      identifier: (name: string) => `\`${name}\``,
      literal: (value: string | null) => (value === null ? 'NULL' : `'${value}'`),
      bytes: (shown: string) => (/^0x[0-9A-F]*$/.test(shown) ? `X'${shown.slice(2)}'` : null),
      overriding: ' OVERRIDING SYSTEM VALUE',
      exportHeader: '-- first\n',
      exportFooter: '-- last\n',
    }
    const text = await new Response(
      exportStream(
        'sql',
        batches(
          {
            columns: [
              { name: 'id', identity: true },
              { name: 'data', bytes: true },
              { name: 'total', generated: true },
              { name: 'note' },
            ],
            rows: [
              ['1', '0x00FF', '9', '0x00FF'],
              ['2', null, '9', null],
              // Not bytes as they're shown: taken as the text it is.
              ['3', 'plain', '9', 'x'],
            ],
          },
          { columns: [], rows: [['4', '0x', '9', 'y']] },
        ),
        target,
        mysql,
        done,
      ),
    ).text()
    expect(text).toBe(
      [
        '-- first',
        "INSERT INTO `public`.`posts` (`id`, `data`, `note`) OVERRIDING SYSTEM VALUE VALUES ('1', X'00FF', '0x00FF');",
        "INSERT INTO `public`.`posts` (`id`, `data`, `note`) OVERRIDING SYSTEM VALUE VALUES ('2', NULL, NULL);",
        "INSERT INTO `public`.`posts` (`id`, `data`, `note`) OVERRIDING SYSTEM VALUE VALUES ('3', 'plain', 'x');",
        "INSERT INTO `public`.`posts` (`id`, `data`, `note`) OVERRIDING SYSTEM VALUE VALUES ('4', X'', 'y');",
        '-- last',
        '',
      ].join('\n'),
    )
    expect(done).toHaveBeenCalledWith(4)
  })

  it('writes a row of nothing but computed columns as an INSERT of defaults', async () => {
    const only = { columns: [{ name: 'total', generated: true }], rows: [['1'], ['2']] }
    expect((await render('sql', only)).text).toBe(
      'INSERT INTO "public"."posts" DEFAULT VALUES;\n'.repeat(2),
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

  it('keeps a column named as something every object has, __proto__ among them', () => {
    const row = jsonObject(['id', '__proto__', 'constructor', 'toString'], ['1', 'a', 'b', null])
    expect(JSON.parse(JSON.stringify(row))).toEqual(
      JSON.parse('{"id":"1","__proto__":"a","constructor":"b","toString":null}'),
    )
    expect(Object.keys(row)).toEqual(['id', '__proto__', 'constructor', 'toString'])
  })
})
