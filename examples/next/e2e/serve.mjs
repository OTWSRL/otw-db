// PostgreSQL for the example, seeded, and a SQLite file beside it, then the example's built
// Next.js server on both, as a site would run in production. Playwright starts and stops it.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startPostgres } from '../../../e2e/postgres.mjs'

const url = await startPostgres(`
  DROP TABLE IF EXISTS guests;
  CREATE TABLE guests (id serial PRIMARY KEY, name text NOT NULL, arrived timestamptz NOT NULL DEFAULT '2026-11-07 18:00:00+00');
  INSERT INTO guests (name) VALUES ('Ada'), ('Grace'), ('Linus');
`)
// SQLite's statements run in a worker whose code the driver carries as text: only a built app
// shows what the build made of that text.
const files = mkdtempSync(join(tmpdir(), 'otw-db-example-next-'))
const notes = new DatabaseSync(join(files, 'notes.db'))
notes.exec(`
  CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  INSERT INTO notes (body) VALUES ('Buy milk'), ('Call Ada');
`)
notes.close()
const next = spawn('npx', ['next', 'start', '-p', '3470'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DB_ADMIN_MAIN_URL: url,
    DB_ADMIN_MAIN_LABEL: 'Guests DB',
    DB_ADMIN_NOTES_URL: `sqlite:${join(files, 'notes.db')}`,
    DB_ADMIN_NOTES_LABEL: 'Notes file',
    DB_ADMIN_PASSWORD: 'the example’s own password',
  },
})
const stop = () => next.kill()
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
next.once('exit', (code) => {
  rmSync(files, { recursive: true, force: true })
  process.exit(code ?? 0)
})
