import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbAdminError, QueryError, type Driver } from '../src/index.ts'

/** A database for the suite: its driver, where its tables live, and what's slow there. */
export interface Fixture {
  driver: Driver
  /** The schema the suite's tables are in: `public`, a MySQL database, SQLite's `main`. */
  schema: string
  product: string
  /** A statement that runs for several seconds, to time out and cancel. */
  slow: string
  /** Closes what the fixture opened beside the driver. */
  close?(): Promise<void>
}

const LIMITS = { maxRows: 1_000, timeoutMs: 10_000 }
const read = { ...LIMITS, access: 'read' as const }
const write = { ...LIMITS, access: 'write' as const }

/** Portable SQL every driver's database takes: the suite's tables and rows. */
const SEED = [
  'DROP TABLE IF EXISTS conf_items',
  'DROP TABLE IF EXISTS conf_big',
  'DROP TABLE IF EXISTS conf_digits',
  `CREATE TABLE conf_items (
     id INTEGER PRIMARY KEY,
     name VARCHAR(50) NOT NULL,
     price DECIMAL(10,2) NOT NULL,
     stock BIGINT NOT NULL DEFAULT 0,
     note TEXT
   )`,
  `INSERT INTO conf_items (id, name, price, stock, note) VALUES
     (1, 'pen', 1.50, 9007199254740993, NULL),
     (2, 'book', 12.00, 3, 'thick'),
     (3, 'lamp', 30.25, 1, NULL)`,
  'CREATE TABLE conf_digits (d INTEGER PRIMARY KEY)',
  'INSERT INTO conf_digits (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)',
  'CREATE TABLE conf_big (id INTEGER PRIMARY KEY, label VARCHAR(20))',
  `INSERT INTO conf_big (id, label)
     SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + 1, 'row'
       FROM conf_digits a, conf_digits b, conf_digits c, conf_digits e
      WHERE a.d + b.d * 10 + c.d * 100 + e.d * 1000 < 2500`,
]

/**
 * What every driver must do, against a real database: the same tests for each, so the browser
 * app works the same whichever it opens.
 */
export function conformance(name: string, open: () => Promise<Fixture>) {
  describe(`${name} conformance`, () => {
    let f: Fixture
    const items = () => ({ schema: f.schema, table: 'conf_items' })
    const ids = async (filters: Parameters<Driver['rows']>[0]['filters']) =>
      (
        await f.driver.rows(
          { ...items(), limit: 10, offset: 0, order: [{ column: 'id' }], filters },
          LIMITS,
        )
      ).rows.map((r) => r[0])
    const all = async () =>
      (await f.driver.query('SELECT id, name, price, stock FROM conf_items ORDER BY id', read)).rows

    beforeAll(async () => {
      f = await open()
      for (const statement of SEED) await f.driver.query(statement, write)
    }, 60_000)

    afterAll(async () => {
      if (!f) return
      for (const table of ['conf_items', 'conf_big', 'conf_digits', 'conf_tmp', 'conf_sneaky']) {
        await f.driver.query(`DROP TABLE IF EXISTS ${table}`, write)
      }
      await f.driver.close()
      await f.close?.()
    })

    it('lists its tables and describes one', async () => {
      const tables = (await f.driver.tables()).filter((t) => t.schema === f.schema)
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining(['conf_big', 'conf_digits', 'conf_items']),
      )
      expect(tables.find((t) => t.name === 'conf_items')!.kind).toBe('table')
      const table = await f.driver.table(f.schema, 'conf_items')
      expect(table!.columns.map((c) => [c.name, c.nullable])).toEqual([
        ['id', false],
        ['name', false],
        ['price', false],
        ['stock', false],
        ['note', true],
      ])
      expect(table!.primaryKey).toEqual(['id'])
      expect(await f.driver.table(f.schema, 'conf_missing')).toBeNull()
    })

    it('returns values as the database’s own text: big integers whole, NULL as null', async () => {
      const { rows, columns } = await f.driver.query(
        'SELECT stock, note, price FROM conf_items WHERE id = 1',
        read,
      )
      expect(columns.map((c) => c.name)).toEqual(['stock', 'note', 'price'])
      expect(rows[0]![0]).toBe('9007199254740993')
      expect(rows[0]![1]).toBeNull()
      expect(Number(rows[0]![2])).toBe(1.5)
    })

    it('pages in order, and says when another page follows', async () => {
      const first = await f.driver.rows(
        { ...items(), limit: 2, offset: 0, order: [{ column: 'price', descending: true }] },
        LIMITS,
      )
      expect(first.rows.map((r) => r[1])).toEqual(['lamp', 'book'])
      expect(first.truncated).toBe(true)
      const last = await f.driver.rows(
        { ...items(), limit: 2, offset: 2, order: [{ column: 'price', descending: true }] },
        LIMITS,
      )
      expect(last.rows.map((r) => r[1])).toEqual(['pen'])
      expect(last.truncated).toBe(false)
    })

    it.each([
      [[{ column: 'price', operator: '>', value: '10' }], ['2', '3']],
      [[{ column: 'name', operator: '=', value: 'pen' }], ['1']],
      [[{ column: 'name', operator: '<>', value: 'pen' }], ['2', '3']],
      [[{ column: 'id', operator: 'in', value: ['1', '3'] }], ['1', '3']],
      [[{ column: 'id', operator: 'not in', value: ['1', '3'] }], ['2']],
      [[{ column: 'price', operator: 'between', value: ['1', '12'] }], ['1', '2']],
      [[{ column: 'note', operator: 'is null' }], ['1', '3']],
      [[{ column: 'note', operator: 'is not null' }], ['2']],
      [[{ column: 'name', operator: 'contains', value: 'AM' }], ['3']],
      [[{ column: 'name', operator: 'starts with', value: 'b' }], ['2']],
      [[{ column: 'name', operator: 'ends with', value: 'n' }], ['1']],
      [[{ column: 'name', operator: 'like', value: 'b%k' }], ['2']],
      [[{ column: 'price', operator: 'contains', value: '.25' }], ['3']],
    ] as const)('filters %j', async (filters, expected) => {
      expect(await ids(filters as never)).toEqual(expected)
    })

    it('takes % and _ in a search literally, and a quote in a value as a quote', async () => {
      expect(await ids([{ column: 'name', operator: 'contains', value: '%' }])).toEqual([])
      expect(await ids([{ column: 'name', operator: 'contains', value: '_' }])).toEqual([])
      expect(await ids([{ column: 'name', operator: '=', value: "x' OR '1'='1" }])).toEqual([])
    })

    it('counts what matches', async () => {
      expect(
        await f.driver.count(
          { ...items(), filters: [{ column: 'price', operator: '>', value: '10' }] },
          LIMITS,
        ),
      ).toBe(2)
    })

    it('takes any name as a name, never as SQL', async () => {
      for (const table of [
        'conf_items"; DROP TABLE conf_big; --',
        'conf_items`; DROP TABLE conf_big; --',
      ]) {
        await expect(
          f.driver.rows({ schema: f.schema, table, limit: 1, offset: 0 }, LIMITS),
        ).rejects.toBeInstanceOf(QueryError)
      }
      expect(await f.driver.table(f.schema, 'conf_big')).not.toBeNull()
    })

    it('refuses writes with read access, schema changes too', async () => {
      await expect(f.driver.query("UPDATE conf_items SET name = 'x'", read)).rejects.toBeInstanceOf(
        QueryError,
      )
      expect((await all())[0]![1]).toBe('pen')
      // MySQL commits before DDL, ending any transaction: only a read-only session stops this.
      await expect(
        f.driver.query('CREATE TABLE conf_sneaky (x INTEGER)', read),
      ).rejects.toBeInstanceOf(QueryError)
      await expect(f.driver.query('DROP TABLE conf_digits', read)).rejects.toBeInstanceOf(
        QueryError,
      )
      expect(await f.driver.table(f.schema, 'conf_sneaky')).toBeNull()
      expect(await f.driver.table(f.schema, 'conf_digits')).not.toBeNull()
    })

    it('runs one statement at a time', async () => {
      await expect(
        f.driver.query('SELECT 1; DELETE FROM conf_items', write),
      ).rejects.toBeInstanceOf(DbAdminError)
      expect(await all()).toHaveLength(3)
    })

    it('cuts results at the row limit and says so', async () => {
      const result = await f.driver.query('SELECT id FROM conf_big ORDER BY id', {
        ...read,
        maxRows: 10,
      })
      expect(result.rows).toHaveLength(10)
      expect(result.truncated).toBe(true)
    })

    it('writes with write access, and changes the schema', async () => {
      const updated = await f.driver.query(
        'UPDATE conf_items SET stock = stock + 1 WHERE id = 3',
        write,
      )
      expect(updated.affectedRows).toBe(1)
      await f.driver.query('UPDATE conf_items SET stock = stock - 1 WHERE id = 3', write)
      await f.driver.query('CREATE TABLE conf_tmp (x INTEGER)', write)
      expect(await f.driver.table(f.schema, 'conf_tmp')).not.toBeNull()
    })

    it('stops a statement at the timeout', async (context) => {
      if (!f.driver.capabilities.cancel) context.skip()
      const started = performance.now()
      await expect(f.driver.query(f.slow, { ...read, timeoutMs: 300 })).rejects.toBeInstanceOf(
        QueryError,
      )
      expect(performance.now() - started).toBeLessThan(5_000)
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('cancels a running statement when asked', async (context) => {
      // PGlite runs on the host's thread: nothing can stop it mid-statement.
      if (!f.driver.capabilities.cancel) context.skip()
      const controller = new AbortController()
      const started = performance.now()
      const query = f.driver.query(f.slow, { ...read, signal: controller.signal })
      setTimeout(() => controller.abort(), 300)
      await expect(query).rejects.toMatchObject({ code: 'canceled' })
      expect(performance.now() - started).toBeLessThan(5_000)
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('applies changes together, and nothing when a row is gone', async () => {
      const preview = await f.driver.apply(
        items(),
        [{ type: 'update', key: { id: '2' }, values: { price: '13' } }],
        {
          ...LIMITS,
          dryRun: true,
        },
      )
      expect(preview).toMatchObject({
        applied: false,
        statements: [
          expect.stringMatching(/^UPDATE .*conf_items.* SET .*price.* = '13' WHERE .*id.* = '2'$/),
        ],
      })
      await f.driver.apply(
        items(),
        [
          { type: 'insert', values: { id: '4', name: 'mug', price: '7.5' } },
          { type: 'update', key: { id: '2' }, values: { price: '13' } },
        ],
        LIMITS,
      )
      const rows = await all()
      expect(rows.map((r) => [r[0], Number(r[2])])).toEqual([
        ['1', 1.5],
        ['2', 13],
        ['3', 30.25],
        ['4', 7.5],
      ])
      // Left out, the stock takes its default.
      expect(rows[3]![3]).toBe('0')
      const before = await all()
      await expect(
        f.driver.apply(
          items(),
          [
            { type: 'delete', key: { id: '4' } },
            { type: 'delete', key: { id: '999' } },
          ],
          LIMITS,
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await all()).toEqual(before)
      await f.driver.apply(
        items(),
        [
          { type: 'delete', key: { id: '4' } },
          { type: 'update', key: { id: '2' }, values: { price: '12.00' } },
        ],
        LIMITS,
      )
      expect(await all()).toHaveLength(3)
    })

    it('counts an unchanged update as the one row it matched', async () => {
      const result = await f.driver.apply(
        items(),
        [{ type: 'update', key: { id: '1' }, values: { name: 'pen' } }],
        LIMITS,
      )
      expect(result.applied).toBe(true)
    })

    it('exports every row in batches, filtered and in order', async () => {
      const sizes: number[] = []
      let last: string | null = null
      for await (const batch of f.driver.export(
        {
          schema: f.schema,
          table: 'conf_big',
          filters: [{ column: 'id', operator: '>', value: '100' }],
          order: [{ column: 'id', descending: true }],
        },
        LIMITS,
      )) {
        expect(batch.columns.map((c) => c.name)).toEqual(['id', 'label'])
        sizes.push(batch.rows.length)
        last = batch.rows.at(-1)![0] ?? null
      }
      expect(sizes).toEqual([1000, 1000, 400])
      expect(last).toBe('101')
      // Stopped early: the driver goes on.
      for await (const batch of f.driver.export({ schema: f.schema, table: 'conf_big' }, LIMITS)) {
        expect(batch.rows).toHaveLength(1000)
        break
      }
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('reports its server', async () => {
      const info = await f.driver.info()
      expect(info.product).toBe(f.product)
      expect(info.version).toMatch(/^\d+\.\d+/)
    })
  })
}
