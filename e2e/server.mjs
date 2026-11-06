// The e2e server: PostgreSQL in Docker (or E2E_POSTGRES_URL), seeded, a SQLite file, and OTW DB's
// built standalone server in front of them with a known token. Playwright starts and stops it.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startServer } from '@otwdesign/db-node/cli'
import { connectionsFromEnv } from '@otwdesign/db-core'
import { startPostgres } from './postgres.mjs'

const PORT = Number(process.env.E2E_PORT ?? 3472)
const TOKEN = process.env.E2E_TOKEN ?? 'e2e-token'
const url = await startPostgres(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'))

// A SQLite file beside it, for the same app on another database.
const notes = join(mkdtempSync(join(tmpdir(), 'otw-db-e2e-')), 'notes.db')
const sqlite = new DatabaseSync(notes)
sqlite.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
  INSERT INTO notes (title, done) VALUES ('Buy milk', 0), ('Ship OTW DB', 1), ('Write docs', 0);`)
sqlite.close()

const connections = connectionsFromEnv({
  DB_ADMIN_LOCAL_URL: `sqlite:${notes}`,
  DB_ADMIN_LOCAL_ACCESS: 'write',
  DB_ADMIN_LOCAL_LABEL: 'Notes',
  DB_ADMIN_LOCAL_TAG: 'local',
  DB_ADMIN_MAIN_URL: url,
  DB_ADMIN_MAIN_ACCESS: 'write',
  DB_ADMIN_MAIN_LABEL: 'Blog',
  DB_ADMIN_MAIN_TAG: 'development',
  DB_ADMIN_LIVE_URL: url,
  DB_ADMIN_LIVE_LABEL: 'Blog (read-only)',
  DB_ADMIN_LIVE_TAG: 'staging',
  DB_ADMIN_OPS_URL: url,
  DB_ADMIN_OPS_ACCESS: 'write',
  DB_ADMIN_OPS_LABEL: 'Operations',
  DB_ADMIN_OPS_TAG: 'production',
})
await startServer({ connections, port: PORT, token: TOKEN })
console.log(`e2e server on http://127.0.0.1:${PORT}`)
