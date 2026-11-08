import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { DbAdminError, QueryError } from '../errors.ts'
import type { Session } from '../types.ts'
import {
  readHeader,
  readTrailer,
  STAGING_SCHEMA,
  type BackupHeader,
  type BackupSummary,
} from './format.ts'
import { StatementSplitter } from './split.ts'

/*
 * A backup restored in one transaction: its statements run as they stream in, and nothing is
 * committed unless every one ran and the file ends with its completion line. A restore that
 * fails, or a file cut short, leaves the database as it was.
 */

/** What restoring a backup would replace here, and what stops it. */
export interface RestorePlan {
  server: string
  serverVersion: number
  schemas: {
    schema: string
    exists: boolean
    tables: number
    views: number
    functions: number
    /** PostgreSQL's estimate. */
    rows: number
  }[]
  /** Objects outside the backup's schemas that depend on what's in them: restoring would drop them. */
  blocked: string[]
  /** Roles the backup's owners, grants and policies name that this server lacks: those are skipped. */
  missingRoles: string[]
  warnings: string[]
}

export interface RestoreProgress {
  statements: number
  /** The backup's bytes read so far, compressed if it is. */
  bytes: number
}

export interface RestoreResult extends BackupSummary {
  statements: number
}

const SERVER_SQL = `SELECT json_build_object('version', current_setting('server_version_num')::int,
  'server', split_part(version(), ' ', 1) || ' ' || current_setting('server_version'))`

const SCHEMAS_SQL = `SELECT coalesce(json_agg(json_build_object('schema', s.name, 'exists', n.oid IS NOT NULL,
    'tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p') AND NOT c.relispartition),
    'views', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('v','m')),
    'functions', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid),
    'rows', (SELECT coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint FROM pg_class c
               WHERE c.relnamespace = n.oid AND c.relkind = 'r'))
    ORDER BY s.name), '[]')
  FROM unnest($1::text[]) AS s(name) LEFT JOIN pg_namespace n ON n.nspname = s.name`

/**
 * What outside the schemas depends on what's in them. A column default, a view's rule, a trigger
 * or a policy belongs to its table's schema, an operator family's member to the family's; a cast,
 * a publication's table or an event trigger to none, so it's outside. The common catalogs are
 * looked up directly; pg_identify_object, slower, answers for the rest.
 */
const BLOCKED_SQL = `WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = ANY($1)),
  inside AS (
    SELECT 'pg_class'::regclass::oid AS cat, c.oid FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM ns)
    UNION ALL SELECT 'pg_type'::regclass::oid, t.oid FROM pg_type t WHERE t.typnamespace IN (SELECT oid FROM ns)
    UNION ALL SELECT 'pg_proc'::regclass::oid, p.oid FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM ns)
    UNION ALL SELECT 'pg_extension'::regclass::oid, x.oid FROM pg_extension x WHERE x.extnamespace IN (SELECT oid FROM ns)
  ),
  deps AS (
    SELECT d.classid, d.objid, d.objsubid, d.refclassid, d.refobjid,
      CASE d.classid
        WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = d.objid)
        WHEN 'pg_type'::regclass THEN (SELECT typnamespace FROM pg_type WHERE oid = d.objid)
        WHEN 'pg_proc'::regclass THEN (SELECT pronamespace FROM pg_proc WHERE oid = d.objid)
        WHEN 'pg_constraint'::regclass THEN (SELECT connamespace FROM pg_constraint WHERE oid = d.objid)
        WHEN 'pg_extension'::regclass THEN (SELECT extnamespace FROM pg_extension WHERE oid = d.objid)
        WHEN 'pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
        WHEN 'pg_rewrite'::regclass THEN (SELECT c.relnamespace FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
        WHEN 'pg_trigger'::regclass THEN (SELECT c.relnamespace FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.oid = d.objid)
        WHEN 'pg_policy'::regclass THEN (SELECT c.relnamespace FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
        WHEN 'pg_amop'::regclass THEN (SELECT f.opfnamespace FROM pg_amop o JOIN pg_opfamily f ON f.oid = o.amopfamily WHERE o.oid = d.objid)
        WHEN 'pg_amproc'::regclass THEN (SELECT f.opfnamespace FROM pg_amproc o JOIN pg_opfamily f ON f.oid = o.amprocfamily WHERE o.oid = d.objid)
        ELSE (SELECT n.oid FROM pg_namespace n WHERE n.nspname = (pg_identify_object(d.classid, d.objid, d.objsubid)).schema)
      END AS ns
    FROM pg_depend d JOIN inside i ON i.cat = d.refclassid AND i.oid = d.refobjid
    WHERE d.deptype IN ('n', 'a')
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = d.classid AND e.objid = d.objid AND e.deptype = 'e')
  )
  SELECT coalesce(json_agg(x.what ORDER BY x.what), '[]') FROM (
    SELECT DISTINCT pg_describe_object(classid, objid, objsubid) || ' needs '
           || pg_describe_object(refclassid, refobjid, 0) AS what
      FROM deps WHERE ns IS NULL OR ns NOT IN (SELECT oid FROM ns) LIMIT 50) x`

const MISSING_ROLES_SQL = `SELECT coalesce(json_agg(r ORDER BY r), '[]') FROM unnest($1::text[]) r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`

/** What restoring `header`'s backup would do here. Runs in any session. */
export async function restorePlan(session: Session, header: BackupHeader): Promise<RestorePlan> {
  // Names described schema-qualified, whatever the login's search_path.
  await session.query(`SELECT set_config('search_path', '', true)`)
  const server = await json<{ version: number; server: string }>(session, SERVER_SQL)
  const schemas = await json<RestorePlan['schemas']>(session, SCHEMAS_SQL, [header.schemas])
  const blocked = await json<string[]>(session, BLOCKED_SQL, [header.schemas])
  const missingRoles = await json<string[]>(session, MISSING_ROLES_SQL, [header.roles])
  const warnings: string[] = []
  if (Math.floor(server.version / 10_000) < Math.floor(header.serverVersion / 10_000)) {
    warnings.push(
      `The backup comes from ${header.server}, newer than this server's ${server.server}: what it uses that this version lacks will fail, and nothing will change.`,
    )
  }
  return {
    server: server.server,
    serverVersion: server.version,
    schemas: schemas.map((s) => ({
      ...s,
      tables: Number(s.tables),
      views: Number(s.views),
      functions: Number(s.functions),
      rows: Number(s.rows),
    })),
    blocked,
    missingRoles,
    warnings,
  }
}

/** Refuses a backup that would drop what's outside it, or touch the restore's own upload. */
export function refuseBlocked(header: BackupHeader, plan: RestorePlan): void {
  if (header.schemas.includes(STAGING_SCHEMA)) {
    throw new DbAdminError(
      `A backup can't hold ${STAGING_SCHEMA}, where restores wait.`,
      400,
      'bad-backup',
    )
  }
  if (plan.blocked.length) {
    throw new DbAdminError(
      `Restoring would also drop what's outside the backup's schemas (${header.schemas.join(', ')}):\n${plan.blocked.join('\n')}\nBack up those schemas too, or remove what depends on them, then restore.`,
      409,
      'restore-blocked',
    )
  }
}

/**
 * Runs the backup in `bytes` (gzipped or not) in `session`, a write session the caller ends:
 * commit once this returns, roll back if it throws. `check` sees the header before anything runs.
 */
export async function restoreSql(
  session: Session,
  bytes: AsyncIterable<Uint8Array>,
  options: {
    check(header: BackupHeader): Promise<void>
    onProgress?(progress: RestoreProgress): void
  },
): Promise<RestoreResult> {
  const progress: RestoreProgress = { statements: 0, bytes: 0 }
  const counted = (async function* () {
    for await (const chunk of bytes) {
      progress.bytes += chunk.byteLength
      yield chunk
    }
  })()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const splitter = new StatementSplitter()
  let header: BackupHeader | null = null
  let start = ''
  /** The end of the text so far, for the last line. */
  let tail = ''
  let reported = 0
  const run = async (statements: string[]) => {
    for (const statement of statements) {
      try {
        await session.query(statement)
      } catch (error) {
        throw failed(progress.statements + 1, statement, error)
      }
      progress.statements += 1
      const now = performance.now()
      if (options.onProgress && now - reported > 250) {
        reported = now
        options.onProgress({ ...progress })
      }
    }
  }
  try {
    for await (const chunk of await text(counted)) {
      const piece = decoder.decode(chunk, { stream: true })
      tail = (tail + piece).slice(-16_384)
      if (!header) {
        start += piece
        const end = start.indexOf('\n')
        if (end === -1) {
          if (start.length > 1_000_000) readHeader(start.slice(0, 200))
          continue
        }
        header = readHeader(start.slice(0, end))
        await options.check(header)
        await run(splitter.push(start))
        start = ''
        continue
      }
      await run(splitter.push(piece))
    }
    const last = decoder.decode()
    tail += last
    if (!header) header = readHeader(start + last)
    await run(splitter.push(last))
    await run(splitter.end())
  } catch (error) {
    if (error instanceof DbAdminError) throw error
    if (error instanceof TypeError && /encoded data|invalid/i.test(error.message)) {
      throw new DbAdminError(
        "The backup isn't valid UTF-8 text: it may be damaged.",
        400,
        'bad-backup',
      )
    }
    const message = (error as Error).message ?? String(error)
    // zlib's, for a damaged or cut .gz; the splitter's, for SQL that ends mid-string.
    throw new DbAdminError(`The backup can't be read: ${message}`, 400, 'bad-backup')
  }
  const lastLine = tail.trimEnd().split('\n').pop() ?? ''
  const summary = readTrailer(lastLine)
  if (!summary) {
    throw new DbAdminError(
      'The backup stops before its end, so nothing was restored: it may have been cut off while downloading. Download it again.',
      400,
      'incomplete-backup',
    )
  }
  options.onProgress?.({ ...progress })
  return { ...summary, statements: progress.statements }
}

/** The bytes as they come, unzipped when they start as gzip does. */
async function text(bytes: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array>) {
  const first = await bytes.next()
  if (first.done) return (async function* () {})()
  const head = first.value
  const all = (async function* () {
    yield head
    yield* { [Symbol.asyncIterator]: () => bytes }
  })()
  if (head[0] !== 0x1f || head[1] !== 0x8b) return all
  return Readable.from(all).pipe(createGunzip()) as AsyncIterable<Uint8Array>
}

/** A statement's failure, saying which and where. */
function failed(n: number, statement: string, error: unknown): DbAdminError {
  const message = (error as Error).message ?? String(error)
  const shown = statement.length > 600 ? `${statement.slice(0, 600)}…` : statement
  const detail = error instanceof QueryError ? error.details : undefined
  return new DbAdminError(
    `Statement ${n.toLocaleString('en')} of the backup failed, so nothing was restored: ${message}${detail?.detail ? `\n${detail.detail}` : ''}\n\n${shown}`,
    400,
    'restore-failed',
  )
}

async function json<T>(session: Session, sql: string, values?: unknown[]): Promise<T> {
  const { rows } = await session.query(sql, values)
  return JSON.parse(rows[0]![0]!) as T
}
