import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { mysqlDriver, pgliteDriver, postgresDriver, sqliteDriver } from '../src/index.ts'
import { conformance } from './conformance.ts'

conformance('PostgreSQL', async () => ({
  driver: postgresDriver(inject('postgresUrl')),
  schema: 'public',
  product: 'PostgreSQL',
  slow: 'SELECT pg_sleep(8)',
}))

const BENCHMARK = "SELECT BENCHMARK(5000000000, MD5('otw'))"

conformance('MySQL', async () => ({
  driver: mysqlDriver(inject('mysqlUrl')),
  schema: 'conf',
  product: 'MySQL',
  slow: BENCHMARK,
}))

conformance('MariaDB', async () => ({
  driver: mysqlDriver(inject('mariadbUrl')),
  schema: 'conf',
  product: 'MariaDB',
  slow: BENCHMARK,
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
    close: () => client.close(),
  }
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
