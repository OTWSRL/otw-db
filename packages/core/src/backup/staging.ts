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
  /** The last piece's number, -1 with none: one less than `chunks` when none is missing. */
  last: number
}

const SCHEMA = quote(STAGING_SCHEMA)

/**
 * Whether the staging schema is there, refusing one this login didn't make. The schema is found
 * by its name, and it's dropped after each restore, so any role that may create schemas could
 * make it first: with tables of its own it would read the uploaded backup, change the pieces
 * before they run as this login, or have a trigger on them run as this login. So the schema and
 * everything in it must belong to the login that uses them.
 */
async function ours(session: Session): Promise<boolean> {
  const { rows } = await session.query(
    `SELECT pg_catalog.pg_get_userbyid(n.nspowner), current_user,
            (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
              WHERE c.relnamespace = n.oid AND c.relowner <> n.nspowner LIMIT 1)
       FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`,
    [STAGING_SCHEMA],
  )
  const found = rows[0]
  if (!found) return false
  const [owner, login, stranger] = found
  const other = owner !== login ? owner : stranger
  if (other !== null && other !== undefined) {
    throw new DbAdminError(
      owner !== login
        ? `The schema ${STAGING_SCHEMA}, where a restore’s upload waits, belongs to "${owner}", not to this connection’s login "${login}": someone else made it. Drop it (DROP SCHEMA ${STAGING_SCHEMA} CASCADE), then restore.`
        : `The schema ${STAGING_SCHEMA}, where a restore’s upload waits, holds a table of "${stranger}", not of this connection’s login "${login}": someone else put it there. Drop the schema (DROP SCHEMA ${STAGING_SCHEMA} CASCADE), then restore.`,
      409,
      'staging-taken',
    )
  }
  return true
}

/** Makes the tables if need be, drops uploads a day old, and starts one. */
export async function startUpload(
  session: Session,
  upload: { viewer: string; kind: UploadKind; size: number; name: string },
): Promise<string> {
  await session.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
  // Before anything is put in it: one made by someone else is refused, not filled.
  await ours(session)
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
  if (!(await ours(session))) throw missing()
  const { rows } = await session.query(
    `SELECT u.kind, u.size, count(c.seq), coalesce(sum(length(c.data)), 0),
            coalesce(max(c.seq), -1)
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
    last: Number(row[4]),
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

/**
 * Refuses an upload with pieces missing: bytes short, or a number skipped. The bytes alone can
 * add up with a piece missing in the middle, when another was sent too long.
 */
export function complete(upload: Upload): void {
  if (upload.received !== upload.size) {
    throw new DbAdminError(
      `The upload isn't complete: ${upload.received.toLocaleString('en')} of ${upload.size.toLocaleString('en')} bytes arrived. Start the restore again.`,
      400,
      'incomplete-upload',
    )
  }
  if (upload.last + 1 !== upload.chunks) {
    throw new DbAdminError(
      `The upload has pieces missing: ${upload.chunks.toLocaleString('en')} arrived, the last of them number ${(upload.last + 1).toLocaleString('en')}. Start the restore again.`,
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
  if (!(await ours(session))) return
  await session.query(
    `DELETE FROM ${SCHEMA}.uploads WHERE id = $1 OR created < now() - interval '1 day'`,
    [id],
  )
  const left = await session.query(`SELECT 1 FROM ${SCHEMA}.uploads LIMIT 1`)
  if (!left.rows.length) await session.query(`DROP SCHEMA ${SCHEMA} CASCADE`)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
