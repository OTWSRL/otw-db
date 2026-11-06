import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inject } from 'vitest'
import { mysqlDriver, postgresDriver, sqliteDriver } from '../src/index.ts'
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
