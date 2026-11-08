import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { DbAdminError, QueryError } from '../errors.ts'
import type { Access, AuditEvent, ConnectionConfig, Driver, Session, Viewer } from '../types.ts'
import {
  backupSql,
  notIncluded,
  prepare,
  schemaChoices,
  type SchemaChoice,
  type Server,
} from './dump.ts'
import {
  backupFileName,
  HEADER_PREFIX,
  readHeader,
  STAGING_SCHEMA,
  type BackupHeader,
} from './format.ts'
import { pgTool, runDump, runRestore, type PgTool } from './pg-tools.ts'
import { refuseBlocked, restorePlan, restoreSql, type RestorePlan } from './restore.ts'
import * as staging from './staging.ts'

/*
 * The backup and restore endpoints, loaded on their first use: a host that never backs up never
 * loads this.
 */

/** What an endpoint gets from the handler: the connection it reached, and who asks. */
export interface BackupContext {
  connection: ConnectionConfig
  access: Access
  db: Driver
  database?: string
  viewer: Viewer
  record(event: Omit<AuditEvent, 'at'>): Promise<void>
  maxRestoreBytes: number
}

/** What the Back up and Restore dialog shows. */
export interface BackupOptions {
  database: string
  server: string
  /** The database runs in the host's process (PGlite): it waits while a backup or restore runs. */
  exclusive: boolean
  schemas: SchemaChoice[]
  notIncluded: { schema: string | null; what: string }[]
  pgDump: PgTool
  pgRestore: PgTool
  restore: { allowed: boolean; chunkBytes: number; maxBytes: number }
}

const NOT_A_SERVER: PgTool = {
  available: false,
  reason: 'This database runs inside the site, where pg_dump and pg_restore can’t reach it.',
}

export async function options(ctx: BackupContext): Promise<BackupOptions> {
  const session = await open(ctx, 'snapshot')
  try {
    const server = await prepare(session)
    const schemas = await schemaChoices(session)
    const missing = await notIncluded(
      session,
      schemas.map((s) => s.name),
    )
    const tools = ctx.db.pgUrl
      ? await Promise.all([pgTool('pg_dump', server.version), pgTool('pg_restore', server.version)])
      : [NOT_A_SERVER, NOT_A_SERVER]
    return {
      database: server.database,
      server: server.server,
      exclusive: session.exclusive,
      schemas,
      notIncluded: missing,
      pgDump: tools[0]!,
      pgRestore: tools[1]!,
      restore: {
        allowed: ctx.access === 'write',
        chunkBytes: staging.CHUNK_BYTES,
        maxBytes: ctx.maxRestoreBytes,
      },
    }
  } finally {
    await session.end(false)
  }
}

/** The backup as a download: SQL, gzipped, or pg_dump's archive. */
export async function download(
  ctx: BackupContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const schemas = schemaList(body.schemas)
  const format = body.format === 'pg_dump' ? 'pg_dump' : body.format === 'sql' ? 'sql' : null
  if (!format) throw bad('"format" is "sql" or "pg_dump".')
  const started = performance.now()
  const now = new Date()
  const audit = (rows: number | undefined, error?: Error) =>
    void ctx.record({
      viewer: ctx.viewer.id,
      connection: ctx.connection.name,
      ...(ctx.database ? { database: ctx.database } : {}),
      action: 'backup',
      statement: `backup of ${schemas.join(', ')} as ${format}`,
      durationMs: Math.round(performance.now() - started),
      ...(rows === undefined ? {} : { rows }),
      ...(error ? { error: error.message } : {}),
    })
  const session = await open(ctx, 'snapshot')
  let server: Server
  try {
    server = await prepare(session)
    const known = new Set((await schemaChoices(session)).map((s) => s.name))
    const unknown = schemas.filter((s) => !known.has(s))
    if (unknown.length)
      throw bad(`There's no schema ${unknown.map((s) => `"${s}"`).join(', ')} to back up.`)
  } catch (error) {
    await session.end(false)
    throw error
  }
  const name = (extension: 'sql.gz' | 'dump') =>
    backupFileName(ctx.connection.name, server.database, now, extension)
  if (format === 'pg_dump') {
    await session.end(false)
    if (!ctx.db.pgUrl) throw bad(NOT_A_SERVER.reason!)
    const tool = await pgTool('pg_dump', server.version)
    if (!tool.available) throw bad(tool.reason!)
    const archive = await runDump(ctx.db.pgUrl, schemas)
    return file(counted(archive, audit), name('dump'), 'application/octet-stream')
  }
  const summary = { tables: 0, rows: 0 }
  const pieces = backupSql(session, server, schemas, now, summary)
  let ended = false
  const end = async () => {
    if (ended) return
    ended = true
    await session
      .end(false)
      .catch((error: unknown) =>
        console.error('otw-db: could not end the backup’s transaction', error),
      )
  }
  if (session.exclusive) {
    // The host waits while this session is open: read it all now, rather than at the pace of
    // the download.
    try {
      const gz = await gzipAll(pieces)
      audit(summary.rows)
      return file(new Blob([gz as BlobPart]).stream(), name('sql.gz'), 'application/gzip')
    } catch (error) {
      audit(undefined, error as Error)
      throw error
    } finally {
      await end()
    }
  }
  // Read the first piece before answering, so a failure is an error rather than a broken file.
  let pending: IteratorResult<string> | null
  try {
    pending = await pieces.next()
  } catch (error) {
    await end()
    throw error
  }
  const encoder = new TextEncoder()
  const text = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await pieces.next())
        pending = null
        if (next.done) {
          await end()
          audit(summary.rows)
          controller.close()
        } else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        await end()
        audit(undefined, error as Error)
        controller.error(error)
      }
    },
    async cancel() {
      await pieces.return(undefined)
      await end()
      audit(summary.rows, new Error('The download stopped before the end.'))
    },
  })
  // TypeScript's DOM types take a CompressionStream's input as any BufferSource; bytes it is.
  const gzip = new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  return file(text.pipeThrough(gzip), name('sql.gz'), 'application/gzip')
}

/** What restoring the backup with `header` would replace, and what stops it. */
export async function plan(
  ctx: BackupContext,
  body: Record<string, unknown>,
): Promise<RestorePlan> {
  mayRestore(ctx)
  const header = headerOf(body.header)
  const session = await open(ctx, 'snapshot')
  try {
    return await restorePlan(session, header)
  } finally {
    await session.end(false)
  }
}

export async function start(
  ctx: BackupContext,
  body: Record<string, unknown>,
): Promise<{ upload: string; chunkBytes: number }> {
  mayRestore(ctx)
  const size = body.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    throw bad('"size" is the backup’s size in bytes.')
  }
  if (size > ctx.maxRestoreBytes) {
    throw new DbAdminError(
      `The backup is ${megabytes(size)}; this tool restores ${megabytes(ctx.maxRestoreBytes)} at most. Restore it with psql or pg_restore instead.`,
      413,
      'too-large',
    )
  }
  const kind = body.kind === 'pg_dump' ? 'pg_dump' : body.kind === 'sql' ? 'sql' : null
  if (!kind) throw bad('"kind" is "sql" or "pg_dump".')
  if (kind === 'pg_dump') await restoreTool(ctx)
  const name = typeof body.name === 'string' ? body.name : 'backup'
  const upload = await write(ctx, (s) =>
    staging.startUpload(s, { viewer: ctx.viewer.id, kind, size, name }),
  )
  return { upload, chunkBytes: staging.CHUNK_BYTES }
}

/** One piece of an upload, as the request's body. */
export async function chunk(ctx: BackupContext, request: Request): Promise<{ received: number }> {
  mayRestore(ctx)
  const params = new URL(request.url).searchParams
  const seq = Number(params.get('seq'))
  const data = await bytes(request, staging.CHUNK_BYTES)
  if (!data.byteLength) throw bad('The piece is empty.')
  await write(ctx, async (s) => {
    const upload = await staging.findUpload(s, String(params.get('upload')), ctx.viewer.id)
    await staging.putChunk(s, upload, seq, data)
  })
  return { received: data.byteLength }
}

/**
 * Runs the restore, answering with a line of JSON as it goes: `progress`, then `done` or
 * `error`. The upload is checked first, so a missing one is a plain error.
 */
export async function run(ctx: BackupContext, body: Record<string, unknown>): Promise<Response> {
  mayRestore(ctx)
  const id = String(body.upload)
  const started = performance.now()
  const session = await open(ctx, 'write')
  let upload: staging.Upload
  try {
    upload = await staging.findUpload(session, id, ctx.viewer.id)
    staging.complete(upload)
  } catch (error) {
    await session.end(false)
    throw error
  }
  let header: BackupHeader | null = null
  const audit = (result: { statements?: number; rows?: number }, error?: Error) =>
    void ctx.record({
      viewer: ctx.viewer.id,
      connection: ctx.connection.name,
      ...(ctx.database ? { database: ctx.database } : {}),
      action: 'restore',
      statement: `restore of ${header ? header.schemas.join(', ') : 'a backup'} (${upload.kind}, ${upload.size} bytes)`,
      durationMs: Math.round(performance.now() - started),
      ...(result.rows === undefined ? {} : { rows: result.rows }),
      ...(error ? { error: error.message } : {}),
    })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      try {
        const result =
          upload.kind === 'sql'
            ? await restoreInSession(
                session,
                upload,
                (h) => (header = h),
                (p) => send({ type: 'progress', ...p }),
              )
            : await restoreArchive(ctx, session, upload, () =>
                send({ type: 'progress', statements: 0, bytes: upload.size }),
              )
        audit(result)
        send({ type: 'done', ...result, durationMs: Math.round(performance.now() - started) })
      } catch (error) {
        const failure =
          error instanceof DbAdminError
            ? error
            : new DbAdminError(
                `The restore failed: ${(error as Error).message}`,
                500,
                'restore-failed',
              )
        audit({}, failure)
        send({ type: 'error', error: { code: failure.code, message: failure.message } })
        // A failed restore's upload goes too: it would only fail again.
        await write(ctx, (s) => staging.discard(s, id)).catch((e: unknown) =>
          console.error('otw-db: could not remove a restore’s upload', e),
        )
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Drops an upload that won't be restored. */
export async function discard(
  ctx: BackupContext,
  body: Record<string, unknown>,
): Promise<{ discarded: true }> {
  mayRestore(ctx)
  const id = String(body.upload)
  await write(ctx, async (s) => {
    await staging.findUpload(s, id, ctx.viewer.id)
    await staging.discard(s, id)
  })
  return { discarded: true }
}

async function restoreInSession(
  session: Session,
  upload: staging.Upload,
  onHeader: (header: BackupHeader) => void,
  onProgress: (progress: { statements: number; bytes: number }) => void,
): Promise<{ statements: number; tables: number; rows: number }> {
  try {
    // A table the site is using makes DROP wait; better to fail soon and say why.
    if (!session.exclusive) await session.query(`SET LOCAL lock_timeout = '10s'`)
    const result = await restoreSql(session, staging.chunks(session, upload), {
      async check(header) {
        onHeader(header)
        refuseBlocked(header, await restorePlan(session, header))
      },
      onProgress,
    })
    await staging.discard(session, upload.id)
    await session.end(true)
    return result
  } catch (error) {
    await session.end(false).catch(() => {})
    if (error instanceof QueryError && error.sqlState === '55P03') {
      throw new DbAdminError(
        'The database is busy: something is using a table the restore replaces. Nothing changed; try again in a moment.',
        409,
        'busy',
      )
    }
    throw error
  }
}

/** pg_dump's archive, put in a file for pg_restore, which restores it in one transaction. */
async function restoreArchive(
  ctx: BackupContext,
  session: Session,
  upload: staging.Upload,
  onStart: () => void,
): Promise<{ statements: number; tables: number; rows: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'otw-db-restore-'))
  const path = join(dir, 'backup.dump')
  try {
    try {
      await pipeline(Readable.from(staging.chunks(session, upload)), createWriteStream(path))
    } finally {
      await session.end(false)
    }
    await restoreTool(ctx)
    onStart()
    await runRestore(ctx.db.pgUrl!, path)
    await write(ctx, (s) => staging.discard(s, upload.id))
    return { statements: 0, tables: 0, rows: 0 }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function restoreTool(ctx: BackupContext): Promise<void> {
  if (!ctx.db.pgUrl) throw bad(NOT_A_SERVER.reason!)
  const session = await open(ctx, 'snapshot')
  let version
  try {
    version = (await prepare(session)).version
  } finally {
    await session.end(false)
  }
  const tool = await pgTool('pg_restore', version)
  if (!tool.available) throw bad(tool.reason!)
}

function mayRestore(ctx: BackupContext): void {
  if (ctx.access !== 'write') {
    throw new DbAdminError(
      `Restoring needs write access, and connection "${ctx.connection.name}" is read-only.`,
      403,
      'read-only',
    )
  }
}

function open(ctx: BackupContext, mode: 'snapshot' | 'write'): Promise<Session> {
  if (typeof ctx.db.session !== 'function') {
    throw new DbAdminError(
      `Connection "${ctx.connection.name}" can't be backed up here: backups are for PostgreSQL.`,
      400,
      'no-backups',
    )
  }
  return ctx.db.session(mode)
}

/** `work` in a write session of its own, committed if it succeeds. */
async function write<T>(ctx: BackupContext, work: (session: Session) => Promise<T>): Promise<T> {
  const session = await open(ctx, 'write')
  try {
    const result = await work(session)
    await session.end(true)
    return result
  } catch (error) {
    await session.end(false).catch(() => {})
    throw error
  }
}

function schemaList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) {
    throw bad('"schemas" lists the schemas to back up.')
  }
  const names = value.map((name) => {
    if (typeof name !== 'string' || !name || new TextEncoder().encode(name).length > 63) {
      throw bad('"schemas" lists the schemas to back up, by name.')
    }
    if (name === STAGING_SCHEMA)
      throw bad(`${STAGING_SCHEMA} is where restores wait: it isn't backed up.`)
    return name
  })
  return [...new Set(names)]
}

/** A header the browser read from the file, checked as the file's own would be. */
function headerOf(value: unknown): BackupHeader {
  if (!value || typeof value !== 'object') throw bad('"header" is the backup’s first line, read.')
  return readHeader(`${HEADER_PREFIX}${JSON.stringify(value)}`)
}

/** The request's body, refused past `max` bytes. */
async function bytes(request: Request, max: number): Promise<Uint8Array> {
  const tooBig = () =>
    new DbAdminError(`A piece of an upload is ${megabytes(max)} at most.`, 413, 'too-large')
  if (Number(request.headers.get('content-length') ?? 0) > max) throw tooBig()
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw tooBig()
    }
    parts.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.byteLength
  }
  return all
}

async function gzipAll(pieces: AsyncIterable<string>): Promise<Buffer> {
  const gzip = createGzip()
  const out: Buffer[] = []
  gzip.on('data', (data: Buffer) => out.push(data))
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve)
    gzip.on('error', reject)
  })
  for await (const piece of pieces) {
    if (!gzip.write(piece)) await new Promise((resolve) => gzip.once('drain', resolve))
  }
  gzip.end()
  await done
  return Buffer.concat(out)
}

/** `stream`, with `audit` told its end: its bytes, or why it stopped. */
function counted(
  stream: ReadableStream<Uint8Array>,
  audit: (rows: number | undefined, error?: Error) => void,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: () => audit(undefined),
    }),
  )
}

function file(body: ReadableStream<Uint8Array>, name: string, type: string): Response {
  return new Response(body, {
    headers: {
      'content-type': type,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toLocaleString('en', { maximumFractionDigits: 1 })} MB`
}

function bad(message: string): DbAdminError {
  return new DbAdminError(message, 400, 'bad-request')
}
