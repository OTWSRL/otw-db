import { spawn } from 'node:child_process'
import { DbAdminError } from '../errors.ts'
import { STAGING_SCHEMA } from './format.ts'

/*
 * pg_dump and pg_restore, where the server running the tool has them (a VPS, a container with
 * the PostgreSQL client), never on a serverless host. Found once, on first use.
 */

export interface PgTool {
  available: boolean
  /** Such as `pg_dump (PostgreSQL) 17.11`. */
  version?: string
  /** Why it can't be used: missing, or older than the server. */
  reason?: string
}

const found = new Map<string, Promise<{ version: string; major: number } | null>>()

function find(name: 'pg_dump' | 'pg_restore') {
  let tool = found.get(name)
  if (!tool) {
    tool = new Promise((resolve) => {
      const child = spawn(name, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (data: Buffer) => (out += data.toString()))
      child.on('error', () => resolve(null))
      child.on('close', (code) => {
        const major = /\)\s+(\d+)/.exec(out)?.[1]
        resolve(code === 0 && major ? { version: out.trim(), major: Number(major) } : null)
      })
    })
    found.set(name, tool)
  }
  return tool
}

/** Whether `name` can work with a server of `serverVersion` (server_version_num). */
export async function pgTool(
  name: 'pg_dump' | 'pg_restore',
  serverVersion: number,
): Promise<PgTool> {
  const tool = await find(name)
  if (!tool)
    return { available: false, reason: `${name} isn't installed on the server running this tool.` }
  const server = Math.floor(serverVersion / 10_000)
  // pg_dump refuses a newer server; pg_restore reads what a pg_dump as new as itself wrote.
  if (tool.major < server) {
    return {
      available: false,
      version: tool.version,
      reason: `${tool.version} is older than the database's PostgreSQL ${server}.`,
    }
  }
  return { available: true, version: tool.version }
}

/**
 * A connection URL as libpq takes it, with the password apart, for the environment rather than
 * the command line, where other users could read it. Supabase's pooler is used in session mode,
 * as a dump runs in one session. node-postgres's own parameters go: libpq refuses those it
 * doesn't know.
 */
export function libpqTarget(connectionUrl: string): { url: string; env: Record<string, string> } {
  const hostless = connectionUrl.includes('@/')
  const url = new URL(hostless ? connectionUrl.replace('@/', '@localhost/') : connectionUrl)
  if (/\.pooler\.supabase\.com$/i.test(url.hostname) && url.port === '6543') url.port = '5432'
  const password = decodeURIComponent(url.password)
  url.password = ''
  const kept: string[] = []
  // By hand rather than through searchParams, which would write the others' %20 as +.
  for (const pair of url.search.slice(1).split('&').filter(Boolean)) {
    const [key = '', value = ''] = pair.split('=')
    if (key === 'uselibpqcompat') continue
    if (key === 'ssl') {
      if (value !== 'false' && value !== '0') kept.push('sslmode=require')
      continue
    }
    if (key === 'sslmode' && value === 'no-verify') {
      kept.push('sslmode=require')
      continue
    }
    kept.push(pair)
  }
  url.search = kept.join('&')
  const href = hostless ? url.href.replace('@localhost/', '@/') : url.href
  return { url: href, env: password ? { PGPASSWORD: password } : {} }
}

/** A schema as a pg_dump pattern that matches it alone: quoted, so * and ? are taken as they are. */
export function schemaPattern(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"`
}

export function dumpArgs(url: string, schemas: readonly string[]): string[] {
  return [
    '--format=custom',
    '--no-password',
    ...schemas.map((schema) => `--schema=${schemaPattern(schema)}`),
    `--exclude-schema=${schemaPattern(STAGING_SCHEMA)}`,
    `--dbname=${url}`,
  ]
}

/**
 * pg_dump's archive, streamed as it writes it. Waits for its first bytes, so a refusal (a wrong
 * password, a newer server) is an error here rather than a broken download.
 */
export async function runDump(
  connectionUrl: string,
  schemas: readonly string[],
): Promise<ReadableStream<Uint8Array>> {
  const { url, env } = libpqTarget(connectionUrl)
  const child = spawn('pg_dump', dumpArgs(url, schemas), {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  const failure = () =>
    new DbAdminError(
      `pg_dump failed: ${errors.trim() || 'it stopped early.'}`,
      502,
      'pg-dump-failed',
    )
  const reader = child.stdout[Symbol.asyncIterator]()
  const first = await Promise.race([reader.next(), exited.then(() => null)])
  if (first === null || first.done) {
    const code = await exited
    if (code !== 0) throw failure()
  }
  let sentFirst = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true
        if (first && !first.done) return controller.enqueue(first.value as Uint8Array)
      }
      const next = await reader.next()
      if (!next.done) return controller.enqueue(next.value as Uint8Array)
      // A broken archive must not look like a whole one: an error the download sees.
      if ((await exited) !== 0) controller.error(failure())
      else controller.close()
    },
    cancel() {
      child.kill()
    },
  })
}

/** pg_restore of `file` in one transaction: replacing what the archive holds, or nothing. */
export async function runRestore(connectionUrl: string, file: string): Promise<void> {
  const { url, env } = libpqTarget(connectionUrl)
  const child = spawn(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      '--exit-on-error',
      '--no-password',
      `--dbname=${url}`,
      file,
    ],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let errors = ''
  child.stderr.on('data', (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', resolve)
    child.on('error', () => resolve(-1))
  })
  if (code !== 0) {
    throw new DbAdminError(
      `pg_restore failed, so nothing was restored: ${errors.trim() || `it exited with ${code}.`}`,
      400,
      'restore-failed',
    )
  }
}
