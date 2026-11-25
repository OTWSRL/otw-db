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
