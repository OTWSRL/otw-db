import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import {
  ConnectionError,
  DbAdminError,
  openDriver,
  postgresDriver,
  QueryError,
  quotePostgres as quote,
  type Driver,
  type PostgresModules,
} from '../src/index.ts'
import { postgresUrlAt } from '../src/drivers/postgres.ts'

const url = inject('postgresUrl')
const LIMITS = { maxRows: 1_000, timeoutMs: 5_000 }
const read = { ...LIMITS, access: 'read' as const }
const write = { ...LIMITS, access: 'write' as const }

let db: Driver
let other: Driver

beforeAll(async () => {
  db = postgresDriver(url)
  other = postgresDriver(url)
  await db.query(
    `DO $$ BEGIN
       DROP SCHEMA IF EXISTS shop CASCADE;
       CREATE SCHEMA shop;
       CREATE TABLE shop.products (
         id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         name text NOT NULL,
         price numeric(10,2) NOT NULL CHECK (price >= 0),
         stock bigint NOT NULL DEFAULT 0,
         added timestamptz NOT NULL DEFAULT '2026-11-06 10:00:00+00',
         details jsonb,
         photo bytea,
         label text GENERATED ALWAYS AS (upper(name)) STORED
       );
       COMMENT ON TABLE shop.products IS 'What the shop sells';
       COMMENT ON COLUMN shop.products.price IS 'In euros';
       CREATE INDEX products_name ON shop.products (name);
       CREATE TABLE shop.orders (
         id serial PRIMARY KEY,
         product integer NOT NULL REFERENCES shop.products (id)
       );
       CREATE VIEW shop.cheap AS SELECT id, name FROM shop.products WHERE price < 10;
       CREATE MATERIALIZED VIEW shop.totals AS SELECT count(*) AS n FROM shop.products;
       INSERT INTO shop.products (name, price, stock, details, photo) VALUES
         ('pen', 1.50, 9007199254740993, '{"b": 1,   "a": [1, 2]}', '\\xdeadbeef'),
         ('book', 12.00, 3, NULL, NULL),
         ('lamp', 30.25, 1, NULL, NULL);
     END $$`,
    write,
  )
  await db.query('ANALYZE shop.products', write)
})

afterAll(async () => {
  await db?.query('DROP SCHEMA IF EXISTS shop CASCADE', write)
  await Promise.all([db?.close(), other?.close()])
})

describe('the PostgreSQL driver', () => {
  it('lists tables, views and materialized views, with estimates and sizes', async () => {
    const shop = (await db.tables()).filter((t) => t.schema === 'shop')
    expect(shop.map((t) => [t.name, t.kind])).toEqual([
      ['cheap', 'view'],
      ['orders', 'table'],
      ['products', 'table'],
      ['totals', 'materialized-view'],
    ])
    const products = shop.find((t) => t.name === 'products')!
    expect(products.estimatedRows).toBe(3)
    expect(products.bytes).toBeGreaterThan(0)
    expect(shop.find((t) => t.name === 'cheap')).toMatchObject({ estimatedRows: null, bytes: null })
    // Never analyzed: no estimate rather than a wrong one.
    expect(shop.find((t) => t.name === 'orders')!.estimatedRows).toBeNull()
    expect(
      (await db.tables()).some(
        (t) => t.schema === 'pg_catalog' || t.schema === 'information_schema',
      ),
    ).toBe(false)
  })

  it('describes a table: columns, keys, indexes, checks and comments', async () => {
    const products = await db.table('shop', 'products')
    expect(products).toMatchObject({
      kind: 'table',
      comment: 'What the shop sells',
      primaryKey: ['id'],
    })
    expect(products!.columns.map((c) => [c.name, c.type, c.nullable, c.generated])).toEqual([
      ['id', 'integer', false, 'always'],
      ['name', 'text', false, null],
      ['price', 'numeric(10,2)', false, null],
      ['stock', 'bigint', false, null],
      ['added', 'timestamp with time zone', false, null],
      ['details', 'jsonb', true, null],
      ['photo', 'bytea', true, null],
      ['label', 'text', true, 'stored'],
    ])
    expect(products!.columns.find((c) => c.name === 'price')!.comment).toBe('In euros')
    expect(products!.columns.find((c) => c.name === 'stock')!.default).toBe('0')
    expect(products!.indexes.map((i) => i.definition)).toEqual([
      'CREATE INDEX products_name ON shop.products USING btree (name)',
      'CREATE UNIQUE INDEX products_pkey ON shop.products USING btree (id)',
    ])
    expect(products!.checks).toEqual([
      { name: 'products_price_check', definition: 'CHECK ((price >= (0)::numeric))' },
    ])
    const orders = await db.table('shop', 'orders')
    expect(orders!.foreignKeys).toEqual([
      {
        name: 'orders_product_fkey',
        definition: 'FOREIGN KEY (product) REFERENCES shop.products(id)',
      },
    ])
    expect(await db.table('shop', 'missing')).toBeNull()
  })

  it('returns values as the database’s own text, so nothing is lost on the way', async () => {
    const result = await db.query(
      "SELECT stock, price, added, details, photo, NULL::text AS nothing FROM shop.products WHERE name = 'pen'",
      read,
    )
    expect(result.columns).toEqual([
      { name: 'stock', type: 'bigint' },
      { name: 'price', type: 'numeric' },
      { name: 'added', type: 'timestamp with time zone' },
      { name: 'details', type: 'jsonb' },
      { name: 'photo', type: 'bytea' },
      { name: 'nothing', type: 'text' },
    ])
    // 2^53 + 1, which a JavaScript number would round.
    expect(result.rows).toEqual([
      [
        '9007199254740993',
        '1.50',
        '2026-11-06 10:00:00+00',
        '{"a": [1, 2], "b": 1}',
        '\\xdeadbeef',
        null,
      ],
    ])
    expect(result).toMatchObject({ command: 'SELECT', affectedRows: 1, truncated: false })
  })

  it('pages through a table in the order asked, and says whether another page follows', async () => {
    const first = await db.rows(
      {
        schema: 'shop',
        table: 'products',
        limit: 2,
        offset: 0,
        order: [{ column: 'price', descending: true }],
      },
      { timeoutMs: 5_000 },
    )
    expect(first.rows.map((r) => r[1])).toEqual(['lamp', 'book'])
    expect(first.truncated).toBe(true)
    const last = await db.rows(
      {
        schema: 'shop',
        table: 'products',
        limit: 2,
        offset: 2,
        order: [{ column: 'price', descending: true }],
      },
      { timeoutMs: 5_000 },
    )
    expect(last.rows.map((r) => r[1])).toEqual(['pen'])
    expect(last.truncated).toBe(false)
  })

  describe('filters', () => {
    const page = (filters: Parameters<Driver['rows']>[0]['filters']) =>
      db.rows(
        {
          schema: 'shop',
          table: 'products',
          limit: 10,
          offset: 0,
          order: [{ column: 'id' }],
          filters,
        },
        { timeoutMs: 5_000 },
      )
    const names = async (filters: Parameters<typeof page>[0]) =>
      (await page(filters)).rows.map((r) => r[1])

    it.each([
      [[{ column: 'price', operator: '>', value: '10' }], ['book', 'lamp']],
      [[{ column: 'price', operator: '<=', value: '12' }], ['pen', 'book']],
      [[{ column: 'name', operator: '=', value: 'pen' }], ['pen']],
      [[{ column: 'name', operator: '<>', value: 'pen' }], ['book', 'lamp']],
      [[{ column: 'id', operator: 'in', value: ['1', '3'] }], ['pen', 'lamp']],
      [[{ column: 'id', operator: 'not in', value: ['1', '3'] }], ['book']],
      [[{ column: 'price', operator: 'between', value: ['1', '12'] }], ['pen', 'book']],
      [[{ column: 'price', operator: 'not between', value: ['1', '12'] }], ['lamp']],
      [[{ column: 'details', operator: 'is null' }], ['book', 'lamp']],
      [[{ column: 'details', operator: 'is not null' }], ['pen']],
      [[{ column: 'name', operator: 'contains', value: 'AM' }], ['lamp']],
      [[{ column: 'name', operator: 'not contains', value: 'o' }], ['pen', 'lamp']],
      [[{ column: 'name', operator: 'starts with', value: 'B' }], ['book']],
      [[{ column: 'name', operator: 'ends with', value: 'n' }], ['pen']],
      [[{ column: 'name', operator: 'like', value: 'b%k' }], ['book']],
      [[{ column: 'name', operator: 'not like', value: 'b%' }], ['pen', 'lamp']],
      // A number's text, searched like any text.
      [[{ column: 'price', operator: 'contains', value: '.25' }], ['lamp']],
      [
        [
          { column: 'price', operator: '>', value: '1' },
          { column: 'name', operator: 'contains', value: 'o' },
        ],
        ['book'],
      ],
    ] as const)('%j', async (filters, expected) => {
      expect(await names(filters as never)).toEqual(expected)
    })

    it('takes % and _ in a search literally', async () => {
      await db.query(
        "INSERT INTO shop.products (name, price) VALUES ('100% wool', 5), ('1000 wool', 5)",
        write,
      )
      expect(await names([{ column: 'name', operator: 'contains', value: '0%' }])).toEqual([
        '100% wool',
      ])
      expect(await names([{ column: 'name', operator: 'contains', value: '0_w' }])).toEqual([])
      await db.query("DELETE FROM shop.products WHERE name LIKE '%wool'", write)
    })

    it('passes values as parameters, so a quote is just a quote', async () => {
      expect(await names([{ column: 'name', operator: '=', value: "x' OR '1'='1" }])).toEqual([])
    })

    it('reports a value the column can’t take as the database does', async () => {
      await expect(
        page([{ column: 'price', operator: '>', value: 'cheap' }]),
      ).rejects.toMatchObject({ sqlState: '22P02' })
    })

    it('counts what matches', async () => {
      const count = (filters?: Parameters<typeof page>[0]) =>
        db.count({ schema: 'shop', table: 'products', filters }, { timeoutMs: 5_000 })
      expect(await count()).toBe(3)
      expect(await count([{ column: 'price', operator: '>', value: '10' }])).toBe(2)
    })
  })

  describe('applying changes', () => {
    const products = { schema: 'shop', table: 'products' }
    const names = async () =>
      (await db.query('SELECT name, price FROM shop.products ORDER BY id', read)).rows

    it('shows the statements with their values written in, and changes nothing on a dry run', async () => {
      const before = await names()
      const { statements, applied } = await db.apply(
        products,
        [
          { type: 'insert', values: { name: "Kid's pen", price: '2.00' } },
          { type: 'update', key: { id: '1' }, values: { name: 'Pen', details: null } },
          { type: 'delete', key: { id: '3' } },
          { type: 'insert', values: {} },
        ],
        { timeoutMs: 5_000, dryRun: true },
      )
      expect(applied).toBe(false)
      expect(statements).toEqual([
        `INSERT INTO "shop"."products" ("name", "price") VALUES ('Kid''s pen', '2.00')`,
        `UPDATE "shop"."products" SET "name" = 'Pen', "details" = NULL WHERE "id" = '1'`,
        `DELETE FROM "shop"."products" WHERE "id" = '3'`,
        'INSERT INTO "shop"."products" DEFAULT VALUES',
      ])
      expect(await names()).toEqual(before)
    })

    it('applies inserts, updates and deletes together, reading each value as its column’s type', async () => {
      await db.apply(
        products,
        [
          { type: 'insert', values: { name: 'Mug', price: '7.5', details: '{"color": "blue"}' } },
          { type: 'update', key: { id: '2' }, values: { price: '13' } },
        ],
        { timeoutMs: 5_000 },
      )
      const rows = (
        await db.query(
          "SELECT price, details->>'color' FROM shop.products WHERE name IN ('Mug', 'book') ORDER BY price",
          read,
        )
      ).rows
      expect(rows).toEqual([
        ['7.50', 'blue'],
        ['13.00', null],
      ])
      const mug = (await db.query("SELECT id FROM shop.products WHERE name = 'Mug'", read))
        .rows[0]![0]!
      await db.apply(products, [{ type: 'delete', key: { id: mug } }], { timeoutMs: 5_000 })
      expect(
        (await db.query("SELECT count(*) FROM shop.products WHERE name = 'Mug'", read)).rows,
      ).toEqual([['0']])
      await db.apply(products, [{ type: 'update', key: { id: '2' }, values: { price: '12.00' } }], {
        timeoutMs: 5_000,
      })
    })

    it('saves nothing when a row it changes is gone, not even the changes before it', async () => {
      const before = await names()
      const error = await db
        .apply(
          products,
          [
            { type: 'update', key: { id: '1' }, values: { name: 'Changed' } },
            { type: 'delete', key: { id: '999' } },
          ],
          { timeoutMs: 5_000 },
        )
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ status: 409, code: 'conflict' })
      expect((error as Error).message).toContain(`DELETE FROM "shop"."products" WHERE "id" = '999'`)
      expect(await names()).toEqual(before)
    })

    it('saves nothing when a key matches more than one row, not even the changes before it', async () => {
      await db.query("INSERT INTO shop.products (name, price) VALUES ('pen', 1.50)", write)
      const before = await names()
      const error = await db
        .apply(
          products,
          [
            { type: 'update', key: { id: '2' }, values: { name: 'changed' } },
            { type: 'delete', key: { price: '1.50' } },
          ],
          { timeoutMs: 5_000 },
        )
        .catch((e: unknown) => e)
      expect(error).toMatchObject({
        code: 'conflict',
        message: expect.stringContaining('its key matched 2 rows'),
      })
      expect(await names()).toEqual(before)
      await db.query(
        'DELETE FROM shop.products WHERE id = (SELECT max(id) FROM shop.products)',
        write,
      )
    })

    it('reports a value the column refuses as the database does, and saves nothing', async () => {
      await expect(
        db.apply(products, [{ type: 'update', key: { id: '1' }, values: { price: '-5' } }], {
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ sqlState: '23514' })
      await expect(
        db.apply(products, [{ type: 'insert', values: { id: '50', name: 'x', price: '1' } }], {
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ sqlState: '428C9' })
    })
  })

  describe('exporting', () => {
    it('reads every row in batches, filtered and in order, in a read-only transaction', async () => {
      await db.query(
        'CREATE TABLE shop.big AS SELECT n AS id, md5(n::text) AS hash FROM generate_series(1, 2500) n',
        write,
      )
      const batches: number[] = []
      let last = ''
      for await (const batch of db.export(
        {
          schema: 'shop',
          table: 'big',
          filters: [{ column: 'id', operator: '>', value: '100' }],
          order: [{ column: 'id', descending: true }],
        },
        { timeoutMs: 5_000 },
      )) {
        expect(batch.columns).toEqual([{ name: 'id' }, { name: 'hash' }])
        batches.push(batch.rows.length)
        last = batch.rows.at(-1)![0]!
      }
      expect(batches).toEqual([1000, 1000, 400])
      expect(last).toBe('101')
    })

    it('gives an empty table its columns', async () => {
      const batches = []
      for await (const batch of db.export(
        { schema: 'shop', table: 'big', filters: [{ column: 'id', operator: '<', value: '0' }] },
        { timeoutMs: 5_000 },
      )) {
        batches.push(batch)
      }
      expect(batches).toEqual([{ columns: [{ name: 'id' }, { name: 'hash' }], rows: [] }])
    })

    it('closes its connection when the reader stops early, and the pool goes on', async () => {
      for await (const batch of db.export({ schema: 'shop', table: 'big' }, { timeoutMs: 5_000 })) {
        expect(batch.rows).toHaveLength(1000)
        break
      }
      // Three queries at once: every connection in the pool of three is usable.
      const answers = await Promise.all([1, 2, 3].map((n) => db.query(`SELECT ${n}`, read)))
      expect(answers.map((a) => a.rows[0]![0])).toEqual(['1', '2', '3'])
      await db.query('DROP TABLE shop.big', write)
    })
  })

  it('reports the server, its database and who it connects as', async () => {
    expect(await db.info()).toEqual({
      product: 'PostgreSQL',
      version: expect.stringMatching(/^17\.\d+$/),
      database: 'postgres',
      user: 'postgres',
    })
  })

  it('takes any name as a name, never as SQL', async () => {
    await expect(
      db.rows(
        { schema: 'shop', table: 'products"; DROP TABLE shop.orders; --', limit: 1, offset: 0 },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ sqlState: '42P01' })
    expect(await db.table('shop', 'orders')).not.toBeNull()
    await expect(
      db.rows(
        { schema: 'shop', table: 'products', limit: 1, offset: 0, order: [{ column: 'id) ; --' }] },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ sqlState: '42703' })
  })

  it('cuts results at the row limit and says so', async () => {
    const result = await db.query('SELECT generate_series(1, 50) AS n', { ...read, maxRows: 10 })
    expect(result.rows).toHaveLength(10)
    expect(result.truncated).toBe(true)
    expect(result.affectedRows).toBeNull()
  })

  describe('with read access', () => {
    it('refuses writes', async () => {
      await expect(
        db.query("INSERT INTO shop.products (name, price) VALUES ('x', 1)", read),
      ).rejects.toMatchObject({
        sqlState: '25006',
        message: 'cannot execute INSERT in a read-only transaction',
      })
    })

    it('runs one statement only, so COMMIT can’t end the read-only transaction for the next', async () => {
      await expect(db.query('COMMIT; DROP TABLE shop.orders', read)).rejects.toMatchObject({
        sqlState: '42601',
        message: 'cannot insert multiple commands into a prepared statement',
      })
      expect(await db.table('shop', 'orders')).not.toBeNull()
    })

    it('leaves nothing on the connection for the next query: settings, roles, session locks', async () => {
      await db.query("SELECT set_config('application_name', 'leaked', false)", read)
      await db.query('SELECT pg_advisory_lock(4242)', read)
      const [name] = (await db.query('SHOW application_name', read)).rows[0]!
      expect(name).toBe('otw-db')
      const [free] = (await other.query('SELECT pg_try_advisory_lock(4242)', read)).rows[0]!
      expect(free).toBe('t')
    })
  })

  describe('with write access', () => {
    it('commits', async () => {
      const result = await db.query(
        "UPDATE shop.products SET stock = stock + 1 WHERE name = 'lamp'",
        write,
      )
      expect(result).toMatchObject({ command: 'UPDATE', affectedRows: 1, rows: [] })
      expect(
        (await db.query("SELECT stock FROM shop.products WHERE name = 'lamp'", read)).rows,
      ).toEqual([['2']])
    })

    it('returns what RETURNING returns, and changes schemas', async () => {
      const inserted = await db.query(
        'INSERT INTO shop.orders (product) VALUES (1) RETURNING id',
        write,
      )
      expect(inserted).toMatchObject({ command: 'INSERT', affectedRows: 1, rows: [['1']] })
      const created = await db.query('CREATE TABLE shop.notes (body text)', write)
      expect(created).toMatchObject({ command: 'CREATE', rows: [], columns: [] })
      expect(await db.table('shop', 'notes')).not.toBeNull()
    })

    it('rolls back a statement that fails', async () => {
      await expect(
        db.query("INSERT INTO shop.products (name, price) VALUES ('free', -1)", write),
      ).rejects.toMatchObject({
        sqlState: '23514',
      })
      expect(
        (await db.query("SELECT count(*) FROM shop.products WHERE name = 'free'", read)).rows,
      ).toEqual([['0']])
    })

    it('runs what can’t run in a transaction, such as VACUUM, on its own', async () => {
      await expect(db.query('VACUUM shop.products', write)).resolves.toMatchObject({
        command: 'VACUUM',
      })
      await expect(db.query('VACUUM shop.products', read)).rejects.toMatchObject({
        sqlState: '25001',
      })
    })

    it('closes the connection after it, so nothing it set reaches the next query', async () => {
      await db.query("SET application_name = 'leaked'", write)
      const [name] = (await db.query('SHOW application_name', read)).rows[0]!
      expect(name).toBe('otw-db')
    })
  })

  it('stops a statement at the timeout', async () => {
    await expect(db.query('SELECT pg_sleep(5)', { ...read, timeoutMs: 200 })).rejects.toMatchObject(
      {
        sqlState: '57014',
        message: 'canceling statement due to statement timeout',
      },
    )
  })

  it('cancels a running statement on the server when asked', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const query = db.query('SELECT pg_sleep(10)', { ...read, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const error = await query.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbAdminError)
    expect(error).toMatchObject({ code: 'canceled', status: 409 })
    expect(performance.now() - started).toBeLessThan(3_000)
    // The connection it ran on is usable again.
    expect((await db.query('SELECT 1', read)).rows).toEqual([['1']])
  })

  it('reports the statement’s error with where it is', async () => {
    const error = await db.query('SELECT * FROM shop.nope', read).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QueryError)
    expect(error).toMatchObject({ sqlState: '42P01', details: { position: 15 } })
  })

  it('reports a database it can’t reach as a connection error', async () => {
    const unreachable = postgresDriver('postgres://nobody:x@127.0.0.1:1/none')
    await expect(unreachable.tables()).rejects.toBeInstanceOf(ConnectionError)
    await unreachable.close()
  })
})

// A package that brings pg and pg-cursor as its own dependencies and is bundled into the app (the
// CMS plugin) hands them over: under pnpm they can't be imported from where the app's bundle runs.
describe('where pg and pg-cursor come from', () => {
  const imports: PostgresModules = () => Promise.all([import('pg'), import('pg-cursor')])

  it('uses the ones it’s given, loaded once', async () => {
    let loads = 0
    const given = postgresDriver(url, {
      modules: () => {
        loads++
        return imports()
      },
    })
    expect((await given.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    await given.query('SELECT 2 AS two', read)
    expect(loads).toBe(1)
    await given.close()
  })

  it('takes each as its import’s namespace or as the package’s own export', async () => {
    const [pg, cursor] = await Promise.all([import('pg'), import('pg-cursor')])
    const given = postgresDriver(url, { modules: async () => [pg.default, cursor.default] })
    expect((await given.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    await given.close()
  })

  it('says why, when they can’t be loaded, and tries again on the next call', async () => {
    let loads = 0
    const broken = postgresDriver(url, {
      modules: () => {
        loads++
        return Promise.reject(new Error('no pg here'))
      },
    })
    const error = await broken.tables().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DbAdminError)
    expect(error).toMatchObject({ code: 'driver-missing', status: 500 })
    expect((error as Error).message).toBe('Could not load pg and pg-cursor: no pg here')
    await expect(broken.tables()).rejects.toThrow('no pg here')
    expect(loads).toBe(2)
    await broken.close()
  })

  it('reaches a PostgreSQL connection opened by openDriver', async () => {
    let loads = 0
    const opened = openDriver(
      { name: 'given', url, access: 'read' },
      {
        postgres: {
          modules: () => {
            loads++
            return imports()
          },
        },
      },
    )
    expect((await opened.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    expect(loads).toBe(1)
    await opened.close()
  })
})

describe('postgresUrlAt', () => {
  it.each([
    [
      'postgres://u:p@db:5432/shop?sslmode=require',
      'postgres://u:p@db:5432/archive?sslmode=require',
    ],
    ['postgresql://u@db', 'postgresql://u@db/archive'],
    ['postgres://u:p%40ss@db/shop', 'postgres://u:p%40ss@db/archive'],
    ['postgres:///shop?host=/var/run/postgresql', 'postgres:///archive?host=/var/run/postgresql'],
    ['postgres://u:p@/shop?host=/tmp', 'postgres://u:p@/archive?host=/tmp'],
  ])('moves %s to another database, keeping the rest', (url, moved) => {
    expect(postgresUrlAt(url, 'archive')).toBe(moved)
  })

  it('escapes a name the way pg reads it back', () => {
    const moved = new URL(postgresUrlAt('postgres://u@db/shop', 'odd name/ü%41'))
    expect(decodeURI(moved.pathname.slice(1))).toBe('odd name/ü%41')
  })

  it.each(['what?', 'one#two'])('refuses %s, which pg can’t read back from a URL', (name) => {
    expect(() => postgresUrlAt('postgres://u@db/shop', name)).toThrow(
      new DbAdminError(
        `The database "${name}" can't be opened: a connection URL can't name a database with ? or #.`,
        400,
        'bad-database',
      ),
    )
  })

  it('names nothing of a URL it can’t read, which may hold a password', () => {
    expect(() => postgresUrlAt('postgres://u:s3cret@db:port/shop', 'archive')).toThrow(
      "The connection's URL can't be moved to another database.",
    )
    expect(() => postgresUrlAt('postgres://u:s3cret@db:port/shop', 'archive')).not.toThrow('s3cret')
  })
})

describe('the server’s other databases', () => {
  const ARCHIVE = 'otw_db_test_archive'
  const ODD = 'otw db test/ü%41'
  const GUEST = 'otw_db_test_guest'
  const opened: Driver[] = []
  const at = (name: string) => {
    const driver = db.withDatabase!(name)
    opened.push(driver)
    return driver
  }

  beforeAll(async () => {
    for (const name of [ARCHIVE, ODD]) {
      await db.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`, write)
      await db.query(`CREATE DATABASE ${quote(name)}`, write)
    }
    await db.query(`DROP ROLE IF EXISTS ${GUEST}`, write)
    await db.query(`CREATE ROLE ${GUEST} LOGIN PASSWORD 'guest'`, write)
    await db.query(`REVOKE CONNECT ON DATABASE ${ARCHIVE} FROM PUBLIC`, write)
    const archive = at(ARCHIVE)
    await archive.query('CREATE TABLE public.notes (id integer PRIMARY KEY, body text)', write)
    await archive.query("INSERT INTO public.notes VALUES (1, 'kept in the archive')", write)
  })

  afterAll(async () => {
    await Promise.all(opened.map((d) => d.close()))
    for (const name of [ARCHIVE, ODD]) {
      await db.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`, write)
    }
    await db.query(`DROP ROLE IF EXISTS ${GUEST}`, write)
  })

  it('lists the databases its login may open, by name, with the one it opened', async () => {
    const { current, databases } = await db.databases!()
    expect(current).toBe('postgres')
    expect(databases).toEqual(expect.arrayContaining(['postgres', ARCHIVE, ODD]))
    expect(databases).not.toContain('template0')
    expect(databases).not.toContain('template1')
    expect(databases).toEqual(
      [...databases].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    )
  })

  it('leaves out a database the login has no CONNECT on', async () => {
    const login = new URL(url)
    login.username = GUEST
    login.password = 'guest'
    const guest = postgresDriver(login.href)
    opened.push(guest)
    const { databases } = await guest.databases!()
    expect(databases).toContain('postgres')
    expect(databases).toContain(ODD)
    expect(databases).not.toContain(ARCHIVE)
  })

  it('opens another database with the same login, its tables its own', async () => {
    const archive = at(ARCHIVE)
    expect(await archive.info()).toMatchObject({ database: ARCHIVE, user: 'postgres' })
    expect((await archive.tables()).map((t) => `${t.schema}.${t.name}`)).toEqual(['public.notes'])
    expect((await archive.query('SELECT body FROM notes', read)).rows).toEqual([
      ['kept in the archive'],
    ])
    expect(await archive.databases!()).toMatchObject({ current: ARCHIVE })
    expect(await db.table('public', 'notes')).toBeNull()
  })

  it('opens a database whose name a URL has to escape', async () => {
    expect((await at(ODD).info()).database).toBe(ODD)
  })

  it('says so when a database is gone', async () => {
    await expect(at('otw_db_test_missing').tables()).rejects.toThrow(
      new ConnectionError(
        'Could not connect to PostgreSQL: database "otw_db_test_missing" does not exist',
      ),
    )
  })
})
