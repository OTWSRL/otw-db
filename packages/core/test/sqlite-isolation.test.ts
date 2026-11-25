import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteDriver, type Driver } from '../src/index.ts'

/*
 * SQLite has no roles, and its file is the host app's own: what one person's statement sets up on
 * a connection (a transaction, another file attached, a TEMP view, a PRAGMA) must not reach the
 * next person's, the grid's edits, or the host.
 */

const READ = { access: 'read' as const, maxRows: 100, timeoutMs: 5_000 }
const WRITE = { ...READ, access: 'write' as const }

describe('a SQLite connection, one statement after another', () => {
  let dir: string
  let file: string
  let other: string
  let driver: Driver
  /** The host app's own connection to the same file. */
  let host: DatabaseSync

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'otw-db-sqlite-isolation-'))
    file = join(dir, 'app.db')
    other = join(dir, 'other.db')
    host = new DatabaseSync(file)
    host.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user INTEGER NOT NULL REFERENCES users (id));
      INSERT INTO users VALUES (1, 'Ada');`)
    const secrets = new DatabaseSync(other)
    secrets.exec(`CREATE TABLE secret (token TEXT); INSERT INTO secret VALUES ('hunter2');`)
    secrets.close()
    driver = sqliteDriver(`sqlite:${file}`)
  })
  afterEach(async () => {
    await driver.close()
    host.close()
    await rm(dir, { recursive: true, force: true })
  })

  const names = async () => (await driver.query('SELECT name FROM users ORDER BY id', READ)).rows

  it('refuses a BEGIN on a write connection, and still commits the writes after it', async () => {
    await expect(driver.query('BEGIN', WRITE)).rejects.toThrow(
      'A transaction can’t stay open here: each statement is committed as it finishes, and BEGIN would leave one open.',
    )
    const inserted = await driver.query(`INSERT INTO users VALUES (2, 'Grace')`, WRITE)
    expect(inserted.affectedRows).toBe(1)
    // Committed: the host's own connection sees it, and so does the next read.
    expect(host.prepare('SELECT name FROM users ORDER BY id').all()).toEqual([
      { name: 'Ada' },
      { name: 'Grace' },
    ])
    expect(await names()).toEqual([['Ada'], ['Grace']])
    await driver.apply(
      { schema: 'main', table: 'users' },
      [{ type: 'insert', values: { id: '3', name: 'Lin' } }],
      { timeoutMs: 5_000 },
    )
    expect(host.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 3 })
  })

  it('refuses a BEGIN on a read connection, which would hold a lock on the host’s file', async () => {
    await expect(driver.query('BEGIN', READ)).rejects.toThrow('A transaction can’t stay open here')
    await expect(driver.query('SAVEPOINT s', READ)).rejects.toThrow(
      'A transaction can’t stay open here',
    )
    expect(await names()).toEqual([['Ada']])
    // The host writes on: no reader sits in a transaction, holding the file.
    host.exec(`INSERT INTO users VALUES (2, 'Grace')`)
    expect(await names()).toEqual([['Ada'], ['Grace']])
  })

  it.each([READ, WRITE])(
    'refuses ATTACH with $access access: it would open another file on the server',
    async (options) => {
      await expect(driver.query(`ATTACH '${other}' AS o`, options)).rejects.toThrow(
        'This connection opens app.db only: ATTACH would open another file on the server.',
      )
      await expect(
        driver.query(`/* quietly */ attach database '${other}' as o`, options),
      ).rejects.toThrow('ATTACH would open another file')
      await expect(driver.query('SELECT token FROM o.secret', options)).rejects.toThrow(
        'no such table: o.secret',
      )
      await expect(driver.query('DETACH main', options)).rejects.toThrow(
        'This connection opens app.db only: DETACH has nothing to let go of.',
      )
    },
  )

  it.each([READ, WRITE])(
    'refuses VACUUM INTO with $access access: it would write a copy anywhere on the server',
    async (options) => {
      const copy = join(dir, 'copy.db')
      await expect(driver.query(`VACUUM INTO '${copy}'`, options)).rejects.toThrow(
        'VACUUM INTO writes a copy of the database to a file on the server, which this tool doesn’t do.',
      )
      await expect(driver.query(`vacuum main into '${copy}'`, options)).rejects.toThrow(
        'VACUUM INTO writes a copy',
      )
      expect(existsSync(copy)).toBe(false)
    },
  )

  it('still runs VACUUM, which SQLite takes outside a transaction only', async () => {
    const result = await driver.query('VACUUM', WRITE)
    expect(result.command).toBe('VACUUM')
  })

  it('forgets what a read statement set up: a TEMP view never stands in for a table', async () => {
    await driver
      .query(`CREATE TEMP VIEW users AS SELECT 0 AS id, 'Mallory' AS name`, READ)
      .catch(() => {})
    expect(await names()).toEqual([['Ada']])
  })

  it('forgets what a write statement set up: a PRAGMA doesn’t reach the next edit', async () => {
    await driver.query('PRAGMA foreign_keys = OFF', WRITE)
    await driver.query(`CREATE TEMP VIEW users AS SELECT 0 AS id, 'Mallory' AS name`, WRITE)
    expect((await driver.query('SELECT name FROM users', WRITE)).rows).toEqual([['Ada']])
    await expect(driver.query('INSERT INTO posts VALUES (1, 99)', WRITE)).rejects.toThrow(
      'FOREIGN KEY constraint failed',
    )
    await expect(
      driver.apply(
        { schema: 'main', table: 'posts' },
        [{ type: 'insert', values: { id: '1', user: '99' } }],
        { timeoutMs: 5_000 },
      ),
    ).rejects.toThrow('FOREIGN KEY constraint failed')
  })

  it.each([
    'PRAGMA hard_heap_limit = 1',
    'pragma hard_heap_limit(1)',
    'PRAGMA/* */main . "hard_heap_limit"/**/=1',
    '-- first\nEXPLAIN PRAGMA [hard_heap_limit] = 1',
    'EXPLAIN QUERY PLAN PRAGMA `soft_heap_limit`=1',
    "PRAGMA temp_store_directory = '/tmp/elsewhere'",
    "PRAGMA data_store_directory = '/tmp/elsewhere'",
  ])(
    'refuses a PRAGMA that sets something for every SQLite file in the server: %s',
    async (sql) => {
      // hard_heap_limit = 1 leaves no SQLite handle in the process able to read a row, the host's
      // own included, until the server restarts; and a PRAGMA acts when it's prepared, EXPLAINed or
      // not.
      for (const options of [READ, WRITE]) {
        await expect(driver.query(sql, options)).rejects.toMatchObject({
          code: 'not-allowed',
          message: expect.stringContaining('for every SQLite database this server has open'),
        })
      }
      expect(await names()).toEqual([['Ada']])
      expect(host.prepare('SELECT name FROM users').all()).toEqual([{ name: 'Ada' }])
      const elsewhere = new DatabaseSync(other)
      expect(elsewhere.prepare('SELECT token FROM secret').all()).toEqual([{ token: 'hunter2' }])
      elsewhere.close()
    },
  )

  it('still runs the PRAGMAs that read, and those that set something for their own statement', async () => {
    expect((await driver.query('PRAGMA table_info(users)', READ)).rows.map((r) => r[1])).toEqual([
      'id',
      'name',
    ])
    expect((await driver.query('PRAGMA hard_heap_limit', READ)).rows).toEqual([['0']])
    expect((await driver.query('PRAGMA soft_heap_limit', READ)).rows).toEqual([['0']])
    await driver.query('PRAGMA foreign_keys = OFF', WRITE)
    await driver.query('PRAGMA cache_size = 100', READ)
    expect((await driver.query('PRAGMA user_version', READ)).rows).toEqual([['0']])
    // A column, a table or a string named like one of them is none of them.
    await driver.query('CREATE TABLE hard_heap_limit (pragma TEXT)', WRITE)
    await driver.query(`INSERT INTO hard_heap_limit VALUES ('PRAGMA hard_heap_limit = 1')`, WRITE)
    expect((await driver.query('SELECT pragma FROM hard_heap_limit', READ)).rows).toEqual([
      ['PRAGMA hard_heap_limit = 1'],
    ])
  })

  /** A statement SQLite never finishes, and never leaves to let JavaScript stop it. */
  const ENDLESS =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c'

  it('really stops a statement at its time limit: the file it was writing is let go of', async () => {
    host.exec('PRAGMA busy_timeout = 0')
    await expect(
      driver.query(`UPDATE users SET name = (${ENDLESS})`, { ...WRITE, timeoutMs: 300 }),
    ).rejects.toThrow('ran past its 300 ms limit')
    // Stopped in name only, it would hold the write lock for as long as the server runs.
    await new Promise((resolve) => setTimeout(resolve, 300))
    host.exec(`INSERT INTO users VALUES (2, 'Grace')`)
    await driver.apply(
      { schema: 'main', table: 'users' },
      [{ type: 'insert', values: { id: '3', name: 'Edsger' } }],
      { timeoutMs: 5_000 },
    )
    expect(await names()).toEqual([['Ada'], ['Grace'], ['Edsger']])
  })

  it('stops a canceled statement the same way, and runs the next one', async () => {
    const controller = new AbortController()
    const running = driver.query(`UPDATE users SET name = (${ENDLESS})`, {
      ...WRITE,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    await expect(running).rejects.toMatchObject({ code: 'canceled' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await driver.query(`UPDATE users SET name = 'Lovelace'`, WRITE)).affectedRows).toBe(1)
  })

  it('runs someone’s SQL on a thread, as it used to, where the server can’t start a process', async () => {
    const node = process.execPath
    Object.defineProperty(process, 'execPath', {
      value: join(dir, 'no-such-node'),
      configurable: true,
    })
    const threaded = sqliteDriver(`sqlite:${file}`)
    try {
      expect((await threaded.query('SELECT name FROM users', READ)).rows).toEqual([['Ada']])
      expect((await threaded.query(`UPDATE users SET name = 'Lovelace'`, WRITE)).affectedRows).toBe(
        1,
      )
      await expect(threaded.query('PRAGMA hard_heap_limit = 1', READ)).rejects.toMatchObject({
        code: 'not-allowed',
      })
      // And its time limit still answers, as before.
      await expect(
        threaded.query(
          'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 300000000) SELECT count(*) FROM c',
          { ...READ, timeoutMs: 200 },
        ),
      ).rejects.toThrow('ran past its 200 ms limit')
    } finally {
      Object.defineProperty(process, 'execPath', { value: node, configurable: true })
      await threaded.close()
    }
  })

  it('goes on exporting when someone else’s statement is stopped at its time limit', async () => {
    host.exec(`CREATE TABLE big (id INTEGER PRIMARY KEY);
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2500)
      INSERT INTO big SELECT n FROM c`)
    const batches = driver.export({ schema: 'main', table: 'big' }, { timeoutMs: 5_000 })
    let rows = (await batches.next()).value!.rows.length
    await expect(
      driver.query(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000000000) SELECT count(*) FROM c',
        { ...READ, timeoutMs: 200 },
      ),
    ).rejects.toThrow('ran past its 200 ms limit')
    for await (const batch of batches) rows += batch.rows.length
    expect(rows).toBe(2500)
  })

  it('lets go of an export nobody reads, so the host’s writes aren’t held up for good', async () => {
    host.exec(`CREATE TABLE big (id INTEGER PRIMARY KEY);
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2500)
      INSERT INTO big SELECT n FROM c`)
    const stalling = sqliteDriver(`sqlite:${file}`, { exportIdleMs: 200 })
    try {
      const batches = stalling.export({ schema: 'main', table: 'big' }, { timeoutMs: 5_000 })
      expect((await batches.next()).value?.rows).toHaveLength(1000)
      // Mid-read, the export holds the file: a write of the host's can't commit.
      expect(() => host.exec(`INSERT INTO users VALUES (2, 'Grace')`)).toThrow('database is locked')
      await new Promise((resolve) => setTimeout(resolve, 700))
      host.exec(`INSERT INTO users VALUES (2, 'Grace')`)
      await expect(batches.next()).rejects.toMatchObject({ code: 'export-stalled' })
    } finally {
      await stalling.close()
    }
  })
})
