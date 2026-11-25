import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, inject, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import mysql from 'mysql2/promise'
import pg from 'pg'
import {
  exportStream,
  mysqlDriver,
  pgliteDriver,
  postgresDriver,
  sqliteDriver,
  type Driver,
} from '../src/index.ts'
import { conformance } from './conformance.ts'

conformance('PostgreSQL', async () => ({
  driver: postgresDriver(inject('postgresUrl')),
  schema: 'public',
  product: 'PostgreSQL',
  slow: 'SELECT pg_sleep(8)',
  bytes: 'BYTEA',
  hex: (hex) => `'\\x${hex}'::bytea`,
  made: `CREATE TABLE conf_made (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, a INTEGER,
    b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`,
}))

const BENCHMARK = "SELECT BENCHMARK(5000000000, MD5('otw'))"

conformance('MySQL', async () => ({
  driver: mysqlDriver(inject('mysqlUrl')),
  schema: 'conf',
  product: 'MySQL',
  slow: BENCHMARK,
  bytes: 'VARBINARY(8)',
  hex: (hex) => `X'${hex}'`,
  made: `CREATE TABLE conf_made (id INTEGER AUTO_INCREMENT PRIMARY KEY, a INTEGER,
    b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`,
}))

conformance('MariaDB', async () => ({
  driver: mysqlDriver(inject('mariadbUrl')),
  schema: 'conf',
  product: 'MariaDB',
  slow: BENCHMARK,
  bytes: 'VARBINARY(8)',
  hex: (hex) => `X'${hex}'`,
  made: `CREATE TABLE conf_made (id INTEGER AUTO_INCREMENT PRIMARY KEY, a INTEGER,
    b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`,
}))

conformance('SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'otw-db-sqlite-'))
  const file = join(dir, 'conf.db')
  // An empty file is an empty database; the driver opens only files that exist.
  await writeFile(file, '')
  return {
    driver: sqliteDriver(`sqlite:${file}`),
    schema: 'main',
    product: 'SQLite',
    slow: 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000000000) SELECT count(*) FROM c',
    bytes: 'BLOB',
    hex: (hex) => `X'${hex}'`,
    made: `CREATE TABLE conf_made (id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER,
      b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`,
    close: () => rm(dir, { recursive: true, force: true }),
  }
})

conformance('PGlite', async () => {
  const client = new PGlite()
  return {
    driver: pgliteDriver(client),
    schema: 'public',
    product: 'PGlite',
    slow: 'SELECT pg_sleep(8)',
    bytes: 'BYTEA',
    hex: (hex) => `'\\x${hex}'::bytea`,
    made: `CREATE TABLE conf_made (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, a INTEGER,
      b INTEGER GENERATED ALWAYS AS (a * 2) STORED)`,
    close: () => client.close(),
  }
})

describe('an SQL export run where strings are read differently', () => {
  const limits = { maxRows: 100, timeoutMs: 10_000 }
  const write = { ...limits, access: 'write' as const }
  /** A value that ends its string, and runs what follows, where a backslash escapes the quote. */
  const SNEAKY = `\\'); DROP TABLE export_victim; --`
  const PLAIN = 'a \\ backslash'

  async function exported(driver: Driver, schema: string): Promise<string> {
    const target = { schema, table: 'export_strings' }
    return await new Response(
      exportStream(
        'sql',
        driver.export({ ...target, order: [{ column: 'id' }] }, limits),
        target,
        driver.sql,
        () => {},
      ),
    ).text()
  }

  async function seed(driver: Driver): Promise<void> {
    for (const sql of [
      'DROP TABLE IF EXISTS export_strings',
      'DROP TABLE IF EXISTS export_victim',
      'CREATE TABLE export_victim (id INTEGER PRIMARY KEY)',
      'CREATE TABLE export_strings (id INTEGER PRIMARY KEY, body VARCHAR(100))',
    ]) {
      await driver.query(sql, write)
    }
    await driver.apply(
      { schema: driver.kind === 'postgres' ? 'public' : 'conf', table: 'export_strings' },
      [
        { type: 'insert', values: { id: '1', body: SNEAKY } },
        { type: 'insert', values: { id: '2', body: PLAIN } },
      ],
      limits,
    )
  }

  it('PostgreSQL: with standard_conforming_strings off or on, its strings read the same', async () => {
    const url = inject('postgresUrl')
    const driver = postgresDriver(url)
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await seed(driver)
      const file = await exported(driver, 'public')
      for (const setting of ['off', 'on']) {
        await client.query(`SET standard_conforming_strings = ${setting}`)
        await client.query('DELETE FROM export_strings')
        // The whole file at once, as a client's query window sends it: the server parses all of
        // it before any of it runs, so nothing the file sets could change how it's read.
        await client.query(file)
        const { rows } = await client.query('SELECT body FROM export_strings ORDER BY id')
        expect(rows.map((r: { body: string }) => r.body)).toEqual([SNEAKY, PLAIN])
      }
      expect((await client.query(`SELECT to_regclass('export_victim') AS t`)).rows[0].t).toBe(
        'export_victim',
      )
    } finally {
      await client.query('DROP TABLE IF EXISTS export_strings, export_victim').catch(() => {})
      await client.end()
      await driver.close()
    }
  })

  it.each([
    ['MySQL', 'mysqlUrl' as const],
    ['MariaDB', 'mariadbUrl' as const],
  ])(
    '%s: in NO_BACKSLASH_ESCAPES mode, the file reads its own way, then puts the mode back',
    async (_, key) => {
      const url = inject(key).replace(/^mariadb:/, 'mysql:')
      const driver = mysqlDriver(inject(key))
      const client = await mysql.createConnection({ uri: url, multipleStatements: true })
      try {
        await seed(driver)
        const file = await exported(driver, 'conf')
        await client.query(
          "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES'); DELETE FROM export_strings",
        )
        const [[{ mode: before }]] = (await client.query(
          'SELECT @@sql_mode AS mode',
        )) as unknown as [[{ mode: string }]]
        expect(before).toContain('NO_BACKSLASH_ESCAPES')
        await client.query(file)
        const [rows] = await client.query('SELECT body FROM export_strings ORDER BY id')
        expect((rows as { body: string }[]).map((r) => r.body)).toEqual([SNEAKY, PLAIN])
        const [[{ mode: after }]] = (await client.query(
          'SELECT @@sql_mode AS mode',
        )) as unknown as [[{ mode: string }]]
        expect(after).toBe(before)
        const [left] = await client.query("SHOW TABLES LIKE 'export_victim'")
        expect(left).toHaveLength(1)
      } finally {
        await client.query('DROP TABLE IF EXISTS export_strings, export_victim').catch(() => {})
        await client.end()
        await driver.close()
      }
    },
  )
})

describe('PGlite shared with its host', () => {
  const read = { access: 'read' as const, maxRows: 100, timeoutMs: 5_000 }
  const write = { ...read, access: 'write' as const }

  it('leaves nothing a write set on the connection the host shares', async () => {
    const client = new PGlite()
    const driver = pgliteDriver(client)
    const settings = async () =>
      (
        await client.query(
          "SELECT current_setting('search_path') AS search_path, current_setting('application_name') AS application_name",
        )
      ).rows[0]
    const before = await settings()
    await driver.query('SET search_path = nowhere', write)
    await driver.query("SET application_name = 'leaked'", write)
    expect(await settings()).toEqual(before)
    await client.close()
  })

  /** What a host may have set up on its one connection, and must find again. */
  const hostState = async (client: PGlite) =>
    (
      await client.query<
        Record<string, unknown>
      >(`SELECT current_setting('search_path') AS search_path,
        current_setting('application_name') AS application_name,
        current_setting('statement_timeout') AS statement_timeout,
        current_user AS "user",
        (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{}') FROM pg_class c
          WHERE c.relnamespace = pg_my_temp_schema() AND c.relkind = 'r') AS temp,
        (SELECT coalesce(array_agg(name::text ORDER BY name), '{}') FROM pg_prepared_statements) AS prepared,
        (SELECT coalesce(array_agg(c ORDER BY c), '{}') FROM pg_listening_channels() c) AS channels,
        (SELECT coalesce(array_agg(objid::int ORDER BY objid), '{}') FROM pg_locks
          WHERE locktype = 'advisory') AS locks`)
    ).rows[0]

  async function host(): Promise<PGlite> {
    const client = new PGlite()
    await client.exec(`CREATE ROLE limited; CREATE SCHEMA app;
      SET search_path = app, public; SET application_name = 'site';
      CREATE TEMP TABLE host_tmp (x integer); LISTEN host_channel;
      PREPARE host_statement AS SELECT 1; SELECT pg_advisory_lock(7);`)
    return client
  }

  const HOST = {
    search_path: 'app, public',
    application_name: 'site',
    statement_timeout: '0',
    user: 'postgres',
    temp: ['host_tmp'],
    prepared: ['host_statement'],
    channels: ['host_channel'],
    locks: [7],
  }

  it('leaves what the host set on its connection as it was, after a write', async () => {
    const client = await host()
    const driver = pgliteDriver(client)
    expect(await hostState(client)).toEqual(HOST)
    for (const sql of [
      'SELECT 1',
      'SET search_path = nowhere',
      "SET application_name = 'leaked'",
      'SET statement_timeout = 5',
      'RESET search_path',
      'SET ROLE limited',
      'CREATE TEMP TABLE tool_tmp (x integer)',
      'LISTEN tool_channel',
      'PREPARE tool_statement AS SELECT 2',
      'SELECT pg_advisory_lock(8), pg_advisory_lock(8)',
      'DISCARD TEMP',
    ]) {
      await driver.query(sql, write)
      expect(await hostState(client), sql).toEqual(
        // DISCARD TEMP is the person's own doing, on a write connection: the host's table goes.
        sql === 'DISCARD TEMP' ? { ...HOST, temp: [] } : HOST,
      )
    }
    await client.close()
  })

  it('leaves the host’s connection as it was after a read, and after statements that fail', async () => {
    const client = await host()
    const driver = pgliteDriver(client)
    await driver.query('SELECT pg_advisory_lock(9)', read)
    expect(await hostState(client)).toEqual(HOST)
    await expect(driver.query('SELECT pg_advisory_lock(10), 1 / 0', read)).rejects.toThrow(
      'division by zero',
    )
    await expect(driver.query('SELECT pg_advisory_lock(11), 1 / 0', write)).rejects.toThrow(
      'division by zero',
    )
    expect(await hostState(client)).toEqual(HOST)
    await client.close()
  })

  it('leaves the host’s connection as it was after a session that set its own, as a restore does', async () => {
    const client = await host()
    const driver = pgliteDriver(client)
    for (const commit of [true, false]) {
      const session = await driver.session!('write')
      await session.query(`SELECT set_config('search_path', '', false)`)
      await session.query('SET statement_timeout = 0')
      await session.query('SET row_security = off')
      await session.query('CREATE TEMP TABLE restore_tmp (x integer)')
      await session.query('SELECT pg_advisory_lock(12)')
      // The host's query waits for the session, then runs with the host's own settings.
      const waiting = hostState(client)
      await session.end(commit)
      // A session lock outlasts a rollback, until the session is put back just after. Within the
      // one connection it stops nobody; the settings are what the host's query must find right.
      expect({ ...(await waiting), locks: [7] }).toEqual(HOST)
      expect(await hostState(client)).toEqual(HOST)
    }
    const backup = await driver.session!('snapshot')
    await backup.query('SELECT 1')
    await backup.end(false)
    expect(await hostState(client)).toEqual(HOST)
    await client.close()
  })

  it('reads no more rows from PGlite than it will show', async () => {
    const client = new PGlite()
    let most = 0
    /** The host's instance, counting the rows each query hands back into the host's memory. */
    const counting = <T extends { query: PGlite['query'] }>(target: T): T =>
      new Proxy(target, {
        get(inner, key, receiver) {
          if (key === 'query') {
            return async (...args: Parameters<PGlite['query']>) => {
              const result = await inner.query(...args)
              most = Math.max(most, result.rows.length)
              return result
            }
          }
          if (key === 'transaction') {
            return (work: (tx: unknown) => Promise<unknown>) =>
              (inner as unknown as PGlite).transaction((tx) =>
                work(counting(tx as unknown as { query: PGlite['query'] })),
              )
          }
          const value = Reflect.get(inner, key, receiver) as unknown
          return typeof value === 'function' ? value.bind(inner) : value
        },
      })
    const driver = pgliteDriver(counting(client) as unknown as PGlite)
    for (const access of ['read', 'write'] as const) {
      most = 0
      const result = await driver.query(
        '/* many */ SELECT g, g::text AS t FROM generate_series(1, 200000) g; -- all of them',
        { access, maxRows: 10, timeoutMs: 30_000 },
      )
      expect(result.rows).toHaveLength(10)
      expect(result.rows[0]).toEqual(['1', '1'])
      expect(result.columns).toEqual([
        { name: 'g', type: 'integer' },
        { name: 't', type: 'text' },
      ])
      expect(result).toMatchObject({ truncated: true, command: 'SELECT', affectedRows: null })
      expect(most).toBeLessThanOrEqual(11)
    }
    // What a cursor can't read runs as it is, and an error still says where it is in the SQL.
    await client.exec('CREATE TABLE made (x integer)')
    const returned = await driver.query(
      'WITH put AS (INSERT INTO made VALUES (1), (2) RETURNING x) SELECT x FROM put',
      { access: 'write', maxRows: 10, timeoutMs: 5_000 },
    )
    expect(returned.rows).toEqual([['1'], ['2']])
    expect((await client.query('SELECT count(*)::int AS n FROM made')).rows).toEqual([{ n: 2 }])
    await expect(
      driver.query('SELECT nope FROM made', { access: 'read', maxRows: 10, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ message: 'column "nope" does not exist', details: { position: 8 } })
    await client.close()
  })

  it('takes every value as its text, as the grid has it: a boolean, a date, bytes, JSON', async () => {
    const client = new PGlite()
    const driver = pgliteDriver(client)
    await client.exec(`CREATE TABLE typed (id integer PRIMARY KEY, flag boolean, day date,
        seen timestamptz, data bytea, doc jsonb, tags text[]);
      INSERT INTO typed VALUES (1, true, '2026-01-02', '2026-01-02 03:04:05+00', '\\x00ff', '{"a": 1}', '{x,y}'),
        (2, false, NULL, NULL, NULL, NULL, NULL)`)
    const target = { schema: 'public', table: 'typed' }
    const limits = { timeoutMs: 5_000 }
    const page = async (filters: Parameters<typeof driver.rows>[0]['filters']) =>
      (await driver.rows({ ...target, limit: 10, offset: 0, filters }, limits)).rows.map(
        (r) => r[0],
      )
    expect(await page([{ column: 'flag', operator: '=', value: 't' }])).toEqual(['1'])
    expect(await page([{ column: 'flag', operator: 'in', value: ['f', 'true'] }])).toEqual([
      '1',
      '2',
    ])
    expect(await page([{ column: 'day', operator: '>=', value: '2026-01-01' }])).toEqual(['1'])
    expect(await page([{ column: 'data', operator: '=', value: '\\x00ff' }])).toEqual(['1'])
    expect(await page([{ column: 'data', operator: 'in', value: ['\\x00ff', '\\x01'] }])).toEqual([
      '1',
    ])
    const [, ...shown] = (await driver.rows({ ...target, limit: 1, offset: 0 }, limits)).rows[0]!
    const columns = ['flag', 'day', 'seen', 'data', 'doc', 'tags']
    await driver.apply(
      target,
      [
        {
          type: 'update',
          key: { id: '2' },
          values: Object.fromEntries(columns.map((c, i) => [c, shown[i]!])),
          original: Object.fromEntries(columns.map((c) => [c, c === 'flag' ? 'f' : null])),
        },
      ],
      limits,
    )
    const rows = (await driver.rows({ ...target, limit: 10, offset: 0 }, limits)).rows
    expect(rows[1]!.slice(1)).toEqual(rows[0]!.slice(1))
    await client.close()
  })

  it('exports a table a batch at a time, the host free between batches', async () => {
    const client = new PGlite()
    await client.exec(
      `CREATE TABLE big AS SELECT g AS id, 'row ' || g AS label FROM generate_series(1, 2500) g`,
    )
    let most = 0
    /** The host's instance, counting the rows each query hands back into the host's memory. */
    const counted = new Proxy(client, {
      get(inner, key, receiver) {
        if (key === 'query') {
          return async (...args: Parameters<PGlite['query']>) => {
            const result = await inner.query(...args)
            most = Math.max(most, result.rows.length)
            return result
          }
        }
        const value = Reflect.get(inner, key, receiver) as unknown
        return typeof value === 'function' ? value.bind(inner) : value
      },
    })
    const driver = pgliteDriver(counted)
    const big = { schema: 'public', table: 'big', order: [{ column: 'id' }] }
    const cursors = async () =>
      // But for the asking query's own, which has no name.
      (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_cursors WHERE name <> ''`,
        )
      ).rows[0]!.n
    const sizes: number[] = []
    let last: string | null = null
    for await (const batch of driver.export(big, { timeoutMs: 10_000 })) {
      sizes.push(batch.rows.length)
      last = batch.rows.at(-1)![0] ?? null
      // The host goes on between two batches: no transaction is held while the file downloads.
      // What it writes meanwhile isn't in the export, which is the table as it was at its start.
      await client.exec(`INSERT INTO big VALUES (${9000 + sizes.length}, 'the host''s')`)
    }
    expect(sizes).toEqual([1000, 1000, 500])
    expect(last).toBe('2500')
    expect(most).toBeLessThanOrEqual(1000)
    expect(await cursors()).toBe(0)
    // Stopped early, it leaves nothing open on the host's connection.
    for await (const batch of driver.export(big, { timeoutMs: 10_000 })) {
      expect(batch.rows).toHaveLength(1000)
      break
    }
    expect(await cursors()).toBe(0)
    await client.close()
  })

  it('lets go of an export nobody reads, and of the rows it kept for it', async () => {
    const client = new PGlite()
    await client.exec(`CREATE TABLE big AS SELECT g AS id FROM generate_series(1, 2500) g`)
    const driver = pgliteDriver(client, { exportIdleMs: 200 })
    const batches = driver.export({ schema: 'public', table: 'big' }, { timeoutMs: 10_000 })
    expect((await batches.next()).value?.rows).toHaveLength(1000)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect((await client.query(`SELECT name FROM pg_cursors WHERE name <> ''`)).rows).toEqual([])
    await expect(batches.next()).rejects.toMatchObject({
      code: 'export-stalled',
      message:
        'The export waited 0.2 s for its rows to be read, and was stopped so its connection is free for others.',
    })
    await client.close()
  })

  it('keeps the host’s own writes out of its read-only transaction', async () => {
    const client = new PGlite()
    const driver = pgliteDriver(client)
    const reading = driver.query('SELECT pg_sleep(0.3)', read)
    // The host writes while the tool reads: PGlite runs them one after the other.
    const hostWrite = client.query('CREATE TABLE host_table (x integer)')
    await Promise.all([reading, hostWrite])
    expect(
      (await client.query("SELECT to_regclass('host_table') IS NOT NULL AS made")).rows,
    ).toEqual([{ made: true }])
    await client.close()
  })
})

describe.each([
  ['MySQL', 'mysqlUrl' as const],
  ['MariaDB', 'mariadbUrl' as const],
])('%s, where KILL QUERY can’t reach a statement', (_, key) => {
  const USER = 'otw_db_one'
  const root = () => mysql.createConnection({ uri: inject(key).replace(/^mariadb:/, 'mysql:') })

  it('still ends the statement at its timeout, and frees its connection', async () => {
    const admin = await root()
    // One connection at most: the one that would carry KILL QUERY is refused, as a proxy that
    // doesn't pass KILL on, or a server at its connection limit, would leave it.
    await admin.query(`DROP USER IF EXISTS '${USER}'@'%'`)
    await admin.query(`CREATE USER '${USER}'@'%' IDENTIFIED BY 'one' WITH MAX_USER_CONNECTIONS 1`)
    await admin.query(`GRANT ALL ON conf.* TO '${USER}'@'%'`)
    const url = new URL(inject(key).replace(/^mariadb:/, 'mysql:'))
    url.username = USER
    url.password = 'one'
    const driver = mysqlDriver(url.href)
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const started = performance.now()
      await expect(
        driver.query('SELECT SLEEP(8)', { access: 'read', maxRows: 10, timeoutMs: 300 }),
      ).rejects.toThrow('The statement ran past its 300 ms limit and was stopped.')
      // Not when SLEEP ends by itself, 8 seconds in.
      expect(performance.now() - started).toBeLessThan(4_000)
      expect(failed).toHaveBeenCalledWith('otw-db: could not stop a MySQL query', expect.anything())
    } finally {
      failed.mockRestore()
      await driver.close()
      await admin.query(`DROP USER IF EXISTS '${USER}'@'%'`)
      await admin.end()
    }
  }, 30_000)
})

describe.each([
  ['MySQL', 'mysqlUrl' as const],
  ['MariaDB', 'mariadbUrl' as const],
])('%s exports and their time limit', (_, key) => {
  const limits = { maxRows: 100, timeoutMs: 10_000 }
  const write = { ...limits, access: 'write' as const }
  /** A view whose one row takes 1.2 s to come. */
  const slow = { schema: 'conf', table: 'export_slow' }

  async function withDriver(work: (driver: Driver) => Promise<void>): Promise<void> {
    const driver = mysqlDriver(inject(key))
    try {
      await driver.query('DROP VIEW IF EXISTS export_slow', write)
      await driver.query('DROP TABLE IF EXISTS export_quick', write)
      await driver.query('CREATE VIEW export_slow AS SELECT SLEEP(1.2) AS s', write)
      await driver.query('CREATE TABLE export_quick (id INTEGER PRIMARY KEY)', write)
      await driver.query('INSERT INTO export_quick VALUES (1), (2)', write)
      await work(driver)
    } finally {
      await driver.query('DROP VIEW IF EXISTS export_slow', write).catch(() => {})
      await driver.query('DROP TABLE IF EXISTS export_quick', write).catch(() => {})
      await driver.close()
    }
  }

  it('leaves no time limit behind on the connection it hands back', async () => {
    await withDriver(async (driver) => {
      let rows = 0
      for await (const batch of driver.export(
        { schema: 'conf', table: 'export_quick' },
        { timeoutMs: 400 },
      )) {
        rows += batch.rows.length
      }
      expect(rows).toBe(2)
      // The next statement on that connection has its own limit, 10 s: 1.2 s is within it.
      const started = performance.now()
      const count = await driver.count(
        { ...slow, filters: [{ column: 's', operator: '=', value: '0' }] },
        limits,
      )
      expect(count).toBe(1)
      expect(performance.now() - started).toBeGreaterThan(1_000)
    })
  })

  it('stops an export that sends nothing within its time limit, and says so', async () => {
    await withDriver(async (driver) => {
      const started = performance.now()
      const reading = (async () => {
        for await (const batch of driver.export(slow, { timeoutMs: 300 })) void batch
      })()
      await expect(reading).rejects.toThrow(
        'The statement ran past its 300 ms limit and was stopped.',
      )
      expect(performance.now() - started).toBeLessThan(1_100)
    })
  })
})
