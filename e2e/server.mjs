// The e2e server: PostgreSQL in Docker (or E2E_POSTGRES_URL), seeded, and OTW DB's built
// standalone server in front of it with a known token. Playwright starts and stops it.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServer } from '@otwdesign/db-node/cli'
import { connectionsFromEnv } from '@otwdesign/db-core'

const require = createRequire(new URL('../packages/core/package.json', import.meta.url))
const { Client } = require('pg')

const PORT = Number(process.env.E2E_PORT ?? 3472)
const TOKEN = process.env.E2E_TOKEN ?? 'e2e-token'
const name = `otw-db-e2e-${process.pid}`
let url = process.env.E2E_POSTGRES_URL
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

if (!url) {
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=e2e',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  )
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop()
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres')
      break
    } catch (error) {
      if (tries > 120) throw error
      await sleep(250)
    }
  }
  url = `postgres://postgres:e2e@127.0.0.1:${port}/postgres`
  // Playwright ends this process with SIGKILL, which no handler sees: a watchdog of its own
  // removes the container once this process is gone, however it went.
  const watchdog = `
    const { execFileSync } = require('node:child_process')
    setInterval(() => {
      try { process.kill(${process.pid}, 0) } catch {
        try { execFileSync('docker', ['rm', '-f', ${JSON.stringify(name)}], { stdio: 'ignore' }) } catch {}
        process.exit(0)
      }
    }, 500)`
  spawn(process.execPath, ['-e', watchdog], { detached: true, stdio: 'ignore' }).unref()
}
const client = new Client({ connectionString: url })
await client.connect()
await client.query(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'))
await client.end()

const connections = connectionsFromEnv({
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
