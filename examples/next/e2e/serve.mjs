// PostgreSQL for the example, seeded, then the example's built Next.js server on it, as a site
// would run in production. Playwright starts and stops it.
import { spawn } from 'node:child_process'
import { startPostgres } from '../../../e2e/postgres.mjs'

const url = await startPostgres(`
  DROP TABLE IF EXISTS guests;
  CREATE TABLE guests (id serial PRIMARY KEY, name text NOT NULL, arrived timestamptz NOT NULL DEFAULT '2026-11-07 18:00:00+00');
  INSERT INTO guests (name) VALUES ('Ada'), ('Grace'), ('Linus');
`)
const next = spawn('npx', ['next', 'start', '-p', '3470'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DB_ADMIN_MAIN_URL: url,
    DB_ADMIN_MAIN_LABEL: 'Guests DB',
    DEMO_SECRET: 'e2e',
  },
})
const stop = () => next.kill()
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
next.once('exit', (code) => process.exit(code ?? 0))
