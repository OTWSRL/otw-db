import { randomUUID } from 'node:crypto'
import { DbAdminError } from '../errors.ts'
import { quote } from '../drivers/postgres-catalog.ts'
import type { Session } from '../types.ts'
import { STAGING_SCHEMA } from './format.ts'

/*
 * A restore's upload, kept in the database it restores until it runs. A host such as Vercel takes
 * at most 4.5 MB a request, so the browser sends a backup in pieces; serverless instances share
 * nothing but the database, so that's where the pieces wait. The restore reads them back inside
 * its own transaction, and the schema goes once nothing waits in it.
 */

/** A piece's most bytes: under Vercel's 4.5 MB a request. */
export const CHUNK_BYTES = 4 * 1024 * 1024

export type UploadKind = 'sql' | 'pg_dump'

export interface Upload {
  id: string
  kind: UploadKind
  size: number
  /** The pieces received, and their bytes. */
  chunks: number
  received: number
}

const SCHEMA = quote(STAGING_SCHEMA)

/** Makes the tables if need be, drops uploads a day old, and starts one. */
export async function startUpload(
  session: Session,
  upload: { viewer: string; kind: UploadKind; size: number; name: string },
): Promise<string> {
  await session.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
  await session.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.uploads (
    id uuid PRIMARY KEY, viewer text NOT NULL, kind text NOT NULL, size bigint NOT NULL,
    name text NOT NULL, created timestamptz NOT NULL DEFAULT now())`)
  await session.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.chunks (
    upload uuid NOT NULL REFERENCES ${SCHEMA}.uploads (id) ON DELETE CASCADE,
    seq integer NOT NULL, data bytea NOT NULL, PRIMARY KEY (upload, seq))`)
  await session.query(`DELETE FROM ${SCHEMA}.uploads WHERE created < now() - interval '1 day'`)
  const id = randomUUID()
  await session.query(
    `INSERT INTO ${SCHEMA}.uploads (id, viewer, kind, size, name) VALUES ($1, $2, $3, $4, $5)`,
    [id, upload.viewer, upload.kind, upload.size, upload.name.slice(0, 200)],
  )
  return id
}

/** The upload `id`, if `viewer` started it. */
export async function findUpload(session: Session, id: string, viewer: string): Promise<Upload> {
  const missing = () =>
    new DbAdminError('That upload is gone: start the restore again.', 404, 'unknown-upload')
  if (!UUID.test(id)) throw missing()
  const exists = await session.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [
    STAGING_SCHEMA,
  ])
  if (!exists.rows.length) throw missing()
  const { rows } = await session.query(
    `SELECT u.kind, u.size, count(c.seq), coalesce(sum(length(c.data)), 0)
       FROM ${SCHEMA}.uploads u LEFT JOIN ${SCHEMA}.chunks c ON c.upload = u.id
      WHERE u.id = $1 AND u.viewer = $2 GROUP BY u.id`,
    [id, viewer],
  )
  const row = rows[0]
  if (!row) throw missing()
  return {
    id,
    kind: row[0] as UploadKind,
    size: Number(row[1]),
    chunks: Number(row[2]),
    received: Number(row[3]),
  }
}

/** Stores piece `seq`; sending a piece again replaces it, so a retry is safe. */
export async function putChunk(
  session: Session,
  upload: Upload,
  seq: number,
  data: Uint8Array,
): Promise<void> {
  // Every piece holds a byte at least, so there are never more pieces than bytes.
  if (!Number.isInteger(seq) || seq < 0 || seq >= Math.max(1, upload.size)) {
    throw new DbAdminError('That piece of the upload is out of order.', 400, 'bad-chunk')
  }
  await session.query(
    `INSERT INTO ${SCHEMA}.chunks (upload, seq, data) VALUES ($1, $2, $3)
     ON CONFLICT (upload, seq) DO UPDATE SET data = EXCLUDED.data`,
    [upload.id, seq, data],
  )
  const { rows } = await session.query(
    `SELECT coalesce(sum(length(data)), 0) FROM ${SCHEMA}.chunks WHERE upload = $1`,
    [upload.id],
  )
  if (Number(rows[0]![0]) > upload.size) {
    throw new DbAdminError('The upload is bigger than it said it would be.', 400, 'bad-chunk')
  }
}

/** Refuses an upload with pieces missing. */
export function complete(upload: Upload): void {
  if (upload.received !== upload.size) {
    throw new DbAdminError(
      `The upload isn't complete: ${upload.received.toLocaleString('en')} of ${upload.size.toLocaleString('en')} bytes arrived. Start the restore again.`,
      400,
      'incomplete-upload',
    )
  }
}

/** The pieces in order, one at a time, so a big backup never sits in memory whole. */
export async function* chunks(session: Session, upload: Upload): AsyncGenerator<Uint8Array> {
  for (let seq = 0; seq < upload.chunks; seq += 1) {
    const { rows } = await session.query(
      `SELECT data FROM ${SCHEMA}.chunks WHERE upload = $1 AND seq = $2`,
      [upload.id, seq],
    )
    const hex = rows[0]?.[0]
    if (hex === undefined || hex === null) {
      throw new DbAdminError(`Piece ${seq + 1} of the upload is missing.`, 400, 'incomplete-upload')
    }
    // bytea comes back as \x and hex, its text form.
    yield Buffer.from(hex.slice(2), 'hex')
  }
}

/** Drops the upload, and the schema once nothing else waits in it. */
export async function discard(session: Session, id: string): Promise<void> {
  const exists = await session.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [
    STAGING_SCHEMA,
  ])
  if (!exists.rows.length) return
  await session.query(
    `DELETE FROM ${SCHEMA}.uploads WHERE id = $1 OR created < now() - interval '1 day'`,
    [id],
  )
  const left = await session.query(`SELECT 1 FROM ${SCHEMA}.uploads LIMIT 1`)
  if (!left.rows.length) await session.query(`DROP SCHEMA ${SCHEMA} CASCADE`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
