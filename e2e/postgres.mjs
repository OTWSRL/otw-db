// PostgreSQL for an e2e run: E2E_POSTGRES_URL when set (CI's service), or a throwaway
// postgres:17-alpine container, seeded with `seed`. Used by the standalone server's suite and the
// Next.js example's.
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(new URL('../packages/core/package.json', import.meta.url))
const { Client } = require('pg')

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

/** A seeded database's URL. The container goes when this process does, however it ends. */
export async function startPostgres(seed) {
  let url = process.env.E2E_POSTGRES_URL
  if (!url) {
    const name = `otw-db-e2e-${process.pid}`
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
    // Playwright ends its web server with SIGKILL, which no handler sees: a watchdog of its own
    // removes the container once this process is gone.
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
  await client.query(seed)
  await client.end()
  return url
}
