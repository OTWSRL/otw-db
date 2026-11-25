import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLITE_PROCESS_WORKER } from '../src/drivers/sqlite.ts'
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
    "PRAGMA lock_proxy_file = '/tmp/elsewhere/made-by-a-reader'",
  ])(
    'refuses a PRAGMA that sets something for every SQLite file in the server: %s',
    async (sql) => {
      // hard_heap_limit = 1 leaves no SQLite handle in the process able to read a row, the host's
      // own included, until the server restarts; and a PRAGMA acts when it's prepared, EXPLAINed or
      // not.
      for (const options of [READ, WRITE]) {
        await expect(driver.query(sql, options)).rejects.toMatchObject({
          code: 'not-allowed',
          message: expect.stringContaining('reaches past this database'),
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

  it('undoes a write stopped part-way, so the grid’s next read finds the file whole', async () => {
    // Killed while it wrote, a statement leaves its journal beside the file. A handle that may
    // write undoes it when it next reads; the grid's, which may only read, couldn't, and failed.
    host.exec('CREATE TABLE filling (n INTEGER)')
    await expect(
      driver.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) INSERT INTO filling SELECT x FROM c',
        { ...WRITE, timeoutMs: 400 },
      ),
    ).rejects.toThrow('ran past its 400 ms limit')
    const grid = await driver.rows(
      { schema: 'main', table: 'users', limit: 10, offset: 0, order: [{ column: 'id' }] },
      { timeoutMs: 5_000 },
    )
    expect(grid.rows).toEqual([['1', 'Ada']])
    expect((await driver.query('SELECT count(*) FROM filling', READ)).rows).toEqual([['0']])
    expect(existsSync(`${file}-journal`)).toBe(false)
  })

  it('stops someone’s statement when the driver is closed, and doesn’t wait for it', async () => {
    const closing = sqliteDriver(`sqlite:${file}`)
    const running = closing.query(ENDLESS, { ...READ, timeoutMs: 60_000 })
    const failed = running.then(
      () => null,
      (error: Error) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = performance.now()
    await closing.close()
    expect(performance.now() - started).toBeLessThan(2_000)
    expect((await failed)?.message).toBe('The SQLite worker stopped.')
  })

  it.skipIf(process.platform === 'win32')(
    'goes on a thread where a process starts and stops at once, and says nothing of it',
    async () => {
      const node = process.execPath
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/false', configurable: true })
      const threaded = sqliteDriver(`sqlite:${file}`)
      try {
        expect((await threaded.query('SELECT name FROM users', READ)).rows).toEqual([['Ada']])
        expect((await threaded.query('SELECT name FROM users', READ)).rows).toEqual([['Ada']])
      } finally {
        Object.defineProperty(process, 'execPath', { value: node, configurable: true })
        await threaded.close()
      }
    },
  )

  it('runs a statement once, however long the server was too busy to hear the process start', async () => {
    // The process has five seconds to say it's up. A server that reads nothing for longer than
    // that found the timer due first, took the process for one that never started, and ran the
    // statement again on a thread: a write, twice.
    const busy = sqliteDriver(`sqlite:${file}`)
    try {
      const inserted = busy.query(`INSERT INTO users VALUES (7, 'Once')`, {
        ...WRITE,
        timeoutMs: 20_000,
      })
      await new Promise((resolve) => setImmediate(resolve))
      const until = Date.now() + 5_600
      while (Date.now() < until) {
        // Nothing of the server's runs meanwhile: not a timer, not a message read.
      }
      expect((await inserted).affectedRows).toBe(1)
      expect(host.prepare('SELECT count(*) AS n FROM users WHERE id = 7').get()).toEqual({ n: 1 })
      // And its statements are still stopped at their limit: it's still a process's.
      host.exec('PRAGMA busy_timeout = 0')
      await expect(
        busy.query(`UPDATE users SET name = (${ENDLESS})`, { ...WRITE, timeoutMs: 300 }),
      ).rejects.toThrow('ran past its 300 ms limit')
      await new Promise((resolve) => setTimeout(resolve, 300))
      host.exec(`INSERT INTO users VALUES (8, 'Free')`)
    } finally {
      await busy.close()
    }
  }, 20_000)

  it('closes at once with statements still to run, runs none of them, and leaves the file whole', async () => {
    host.exec('CREATE TABLE filling (n INTEGER)')
    const closing = sqliteDriver(`sqlite:${file}`)
    const settled = (query: Promise<unknown>) =>
      query.then(
        () => 'ran',
        () => 'failed',
      )
    const writing = settled(
      closing.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) INSERT INTO filling SELECT x FROM c',
        { ...WRITE, timeoutMs: 60_000 },
      ),
    )
    const behind = [1, 2, 3].map((n) =>
      settled(
        closing.query(`INSERT INTO users VALUES (${10 + n}, 'Late')`, {
          ...WRITE,
          timeoutMs: 5_000,
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const started = performance.now()
    await closing.close()
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(await Promise.all([writing, ...behind])).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
    ])
    // Nothing of them was written, and no journal is left for the next reader to trip on.
    expect(existsSync(`${file}-journal`)).toBe(false)
    expect(await names()).toEqual([['Ada']])
    expect((await driver.query('SELECT count(*) FROM filling', READ)).rows).toEqual([['0']])
  })

  it('reads a file a writer was killed over, undoing what the writer left', async () => {
    // Not this driver's own statement: the app's, or the server's, stopped mid-write. Its
    // journal is beside the file, and a handle that may only read can't undo it.
    const crashed = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
         const db = new DatabaseSync(process.env.FILE)
         db.exec('PRAGMA cache_size = 5; CREATE TABLE IF NOT EXISTS crashing (t TEXT); BEGIN')
         const insert = db.prepare('INSERT INTO crashing VALUES (?)')
         for (let i = 0; i < 4000; i++) insert.run('x'.repeat(500))
         process.kill(process.pid, 'SIGKILL')`,
      ],
      { env: { ...process.env, FILE: file } },
    )
    expect(crashed.signal).toBe('SIGKILL')
    expect(existsSync(`${file}-journal`)).toBe(true)
    const fresh = sqliteDriver(`sqlite:${file}`)
    try {
      const grid = await fresh.rows(
        { schema: 'main', table: 'users', limit: 10, offset: 0, order: [{ column: 'id' }] },
        { timeoutMs: 5_000 },
      )
      expect(grid.rows).toEqual([['1', 'Ada']])
      expect((await fresh.query('SELECT name FROM users', READ)).rows).toEqual([['Ada']])
    } finally {
      await fresh.close()
    }
  })

  it('reads a statement’s first word in no time, however many comments stand before it', async () => {
    // A pattern for "any number of comments" tried every way to split them when no word came
    // after: 28 of them held the server for seconds, on its own thread, before any time limit.
    const started = performance.now()
    await expect(
      driver.query('/**/'.repeat(4_000) + '!', { ...READ, timeoutMs: 500 }),
    ).rejects.toThrow()
    expect(
      (await driver.query('/**/'.repeat(4_000) + 'SELECT name FROM users', READ)).rows,
    ).toEqual([['Ada']])
    expect(performance.now() - started).toBeLessThan(1_500)
  })

  it('answers nothing once it’s closed, and starts nothing', async () => {
    const closed = sqliteDriver(`sqlite:${file}`)
    expect(await closed.tables()).not.toEqual([])
    await closed.close()
    await expect(closed.tables()).rejects.toThrow('The SQLite connection was closed.')
    await expect(closed.query('SELECT 1', READ)).rejects.toThrow(
      'The SQLite connection was closed.',
    )
  })

  it('ends a statement with no end when the server that asked for it is gone', async () => {
    // A server standing in for the host: it starts the process as the driver does, sends it a
    // statement that never finishes, says which process that is, and waits to be killed.
    const server = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '-e',
        `const { spawn } = require('node:child_process')
         const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', process.env.WORKER], {
           stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
           serialization: 'advanced',
           env: { ...process.env, OTW_DB_SQLITE_WORKER: JSON.stringify({ path: process.env.FILE }) },
         })
         child.on('message', (message) => console.log('answer ' + JSON.stringify(message)))
         child.send({ id: 1, type: 'run', sql: 'SELECT name FROM users', params: [], maxRows: 10, write: false, transaction: false, own: true })
         setTimeout(() => {
           child.send({ id: 2, type: 'run', sql: process.env.ENDLESS, params: [], maxRows: 10, write: false, transaction: false, own: true })
           console.log('pid ' + child.pid)
         }, 300)
         setInterval(() => {}, 1000)`,
      ],
      {
        env: { ...process.env, WORKER: SQLITE_PROCESS_WORKER, FILE: file, ENDLESS },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    let said = ''
    server.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      await vi.waitFor(() => expect(said).toMatch(/pid \d+/), { timeout: 5_000 })
      // It answers as the thread does: the first statement came back before the endless one.
      expect(said).toContain(
        'answer {"id":1,"result":{"columns":[{"name":"name","type":"text"}],"rows":[["Ada"]]',
      )
      const child = Number(/pid (\d+)/.exec(said)![1])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(alive(child)).toBe(true)
      // Killed, not stopped: nothing of the server's runs to tell the process to go.
      server.kill('SIGKILL')
      await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5_000 })
    } finally {
      server.kill('SIGKILL')
      const child = Number(/pid (\d+)/.exec(said)?.[1])
      if (child && alive(child)) process.kill(child, 'SIGKILL')
    }
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
