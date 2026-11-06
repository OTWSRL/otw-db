import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { connectionsFromEnv, createDbAdmin, type ConnectionConfig } from '@otwdesign/db-core'
import { toNodeHandler } from './index.ts'

const COOKIE = 'otw_db_token'

export interface ServerOptions {
  connections: readonly ConnectionConfig[]
  /** Default 4010; 0 picks a free port. */
  port?: number
  /** Default 127.0.0.1: only this machine. */
  host?: string
  /** Generated when not given. */
  token?: string
}

export interface RunningServer {
  /** Opening it signs the browser in. */
  url: string
  token: string
  close(): Promise<void>
}

/**
 * OTW DB on its own HTTP server. Anyone with the token may use it, so it listens on this machine
 * only unless told otherwise; the link it prints signs the browser in with an HttpOnly cookie.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString('base64url')
  const admin = createDbAdmin({
    connections: options.connections,
    authorize: (request) => (holdsToken(request, token) ? { id: 'local' } : null),
  })
  const handle = toNodeHandler(admin)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const given = url.searchParams.get('token')
    if (given !== null) {
      url.searchParams.delete('token')
      const back = `${url.pathname}${url.search}`
      res.statusCode = 303
      res.setHeader('location', back)
      if (same(given, token)) {
        res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`)
      }
      res.end()
      return
    }
    void handle(req, res)
  })
  await listen(server, options.port ?? 4010, options.host ?? '127.0.0.1')
  const { port, address } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  return {
    url: `http://${host}:${port}/?token=${token}`,
    token,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await admin.close()
    },
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function holdsToken(request: Request, token: string): boolean {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === COOKIE)?.[1]
  return [bearer, cookie].some((given) => given !== undefined && same(given, token))
}

function same(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const HELP = `otw-db: a database manager in your browser

Usage: otw-db [--port 4010] [--host 127.0.0.1] [--env-file .env]

Connections come from the environment (and .env, when there is one):
  DB_ADMIN_<NAME>_URL     postgres://user:password@host:5432/db
  DB_ADMIN_<NAME>_ACCESS  read (default) or write
  DB_ADMIN_<NAME>_LABEL   shown instead of the name
  DB_ADMIN_<NAME>_TAG     local, development, testing, staging or production
`

/** The `otw-db` command. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '4010' },
      host: { type: 'string', default: '127.0.0.1' },
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(HELP)
    return
  }
  const envFile = values['env-file'] ?? (existsSync('.env') ? '.env' : undefined)
  if (envFile) process.loadEnvFile(envFile)
  const connections = connectionsFromEnv()
  if (!connections.length) {
    process.stderr.write(`No connections: set DB_ADMIN_<NAME>_URL.\n\n${HELP}`)
    process.exitCode = 1
    return
  }
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port is a port number, not "${values.port}".`)
  }
  const server = await startServer({ connections, port, host: values.host })
  process.stdout.write(`OTW DB is running. Open ${server.url}\n`)
  const stop = () => void server.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
