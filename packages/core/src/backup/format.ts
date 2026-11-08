import { DbAdminError } from '../errors.ts'

/*
 * The backup file: plain SQL that psql can run too, with one JSON line at the top saying what's in
 * it, and one at the bottom saying it's whole. A download that stopped early has no last line, so
 * it's refused before anything it would change is committed.
 */

/** The file's first line starts with this, then the header as JSON. */
export const HEADER_PREFIX = '-- otw-db backup '
/** Its last line starts with this, then the summary as JSON. */
export const TRAILER_PREFIX = '-- otw-db backup complete '
/** The format this code writes, and the newest it reads. */
export const BACKUP_VERSION = 1
/** Where a restore's upload waits, in the database it restores; never in a backup. */
export const STAGING_SCHEMA = 'otw_db_restore'

/** What a backup holds, from its first line. */
export interface BackupHeader {
  format: 'otw-db'
  version: number
  createdAt: string
  database: string
  /** Such as `PostgreSQL 17.5`. */
  server: string
  /** server_version_num: 170005 for 17.5. */
  serverVersion: number
  /** The schemas it replaces when restored. */
  schemas: string[]
  /** Roles its owners, grants and policies name: a server without them skips those. */
  roles: string[]
  /** What the database had that the backup doesn't, such as `aggregate public.median(numeric)`. */
  notIncluded: string[]
}

/** How much a backup holds, from its last line. */
export interface BackupSummary {
  tables: number
  rows: number
}

export function headerLine(header: BackupHeader): string {
  return `${HEADER_PREFIX}${JSON.stringify(header)}\n`
}

export function trailerLine(summary: BackupSummary): string {
  return `${TRAILER_PREFIX}${JSON.stringify(summary)}\n`
}

/** The header from a backup's first line; refuses anything else, or a newer format. */
export function readHeader(line: string): BackupHeader {
  const header = line.startsWith(HEADER_PREFIX) ? parse(line.slice(HEADER_PREFIX.length)) : null
  if (
    header?.format !== 'otw-db' ||
    typeof header.version !== 'number' ||
    !names(header.schemas) ||
    !header.schemas.length
  ) {
    throw new DbAdminError(
      "This file isn't an otw-db backup: its first line should start with “-- otw-db backup”.",
      400,
      'not-a-backup',
    )
  }
  if (header.version > BACKUP_VERSION) {
    throw new DbAdminError(
      `This backup was made by a newer otw-db (format ${header.version}): update otw-db to restore it.`,
      400,
      'newer-backup',
    )
  }
  return {
    ...header,
    roles: names(header.roles) ? header.roles : [],
    notIncluded: names(header.notIncluded) ? header.notIncluded : [],
    serverVersion: typeof header.serverVersion === 'number' ? header.serverVersion : 0,
  } as BackupHeader
}

/** A list of names, as a header has them: strings, and not absurdly many. */
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((v) => typeof v === 'string')
}

function parse(json: string): Partial<BackupHeader> | null {
  try {
    return JSON.parse(json) as Partial<BackupHeader>
  } catch {
    return null
  }
}

/** The summary from a backup's last line, or null when the file stops before it. */
export function readTrailer(line: string): BackupSummary | null {
  if (!line.startsWith(TRAILER_PREFIX)) return null
  try {
    const summary = JSON.parse(line.slice(TRAILER_PREFIX.length)) as BackupSummary
    return typeof summary?.tables === 'number' && typeof summary.rows === 'number' ? summary : null
  } catch {
    return null
  }
}

/** `shop-main-2026-11-08-1430.sql.gz`: the connection, the database and when, safe as a file name. */
export function backupFileName(
  connection: string,
  database: string,
  at: Date,
  extension: 'sql.gz' | 'dump',
): string {
  const stamp = at.toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  const safe = (part: string) => part.replace(/[^\w.-]+/g, '_').slice(0, 60)
  return `${safe(connection)}-${safe(database)}-${stamp}.${extension}`
}
