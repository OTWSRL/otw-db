import { DbAdminError } from '../errors.ts'
import { firstWords } from '../words.ts'

/*
 * What read access doesn't run, though the database would. A read-only transaction keeps a
 * statement from changing rows; the server's files, its programs, its settings and its other
 * connections aren't rows, and a login that may touch them (a superuser, root, and PGlite, which
 * has no other kind) still can through a connection marked read-only: COPY … TO PROGRAM runs a
 * command on the database's server.
 *
 * A statement is refused by its first word, or by a name anywhere in its text, strings and
 * comments included: read where a string really ends, differently from the server, a name hidden
 * in one would get through. So a statement that only mentions one of them is refused too, which
 * read access can live with. It isn't a wall around a superuser: a function already in the
 * database can do anything. A read-only connection is safest with a login that can only read.
 */

function refuse(what: string): never {
  throw new DbAdminError(`This connection is read-only: ${what}`, 403, 'not-allowed')
}

/** Functions that read or write the server's files, signal its other connections, or open another connection. */
const POSTGRES_NAMES =
  /\b(lo_export|lo_import|pg_read_file|pg_read_binary_file|pg_ls_[a-z_]*dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|dblink\w*)\b/i

/** PostgreSQL, and PGlite, which is one. */
export function refuseBeyondReadingPostgres(sql: string): void {
  const word = firstWords(sql).split(' ')[0]!.toUpperCase()
  if (word === 'COPY') {
    refuse('COPY reads and writes files on the database’s server, and runs programs there.')
  }
  if (word === 'DO') {
    refuse('a DO block runs code of its own, which can’t be held to reading.')
  }
  const name = POSTGRES_NAMES.exec(sql)?.[1]
  if (name) {
    refuse(
      `${name.toLowerCase()} reaches past the database, to the server’s files or its other connections. A statement that only mentions it is refused as well.`,
    )
  }
  // A name spelled in escapes is a name this can't read.
  if (/U&"/i.test(sql)) refuse('names written with U&"…" escapes aren’t taken here.')
}

/** MySQL's statements for the server itself, which no transaction holds back. */
const MYSQL_STATEMENTS = new Set([
  'KILL',
  'SHUTDOWN',
  'RESTART',
  'FLUSH',
  'RESET',
  'PURGE',
  'INSTALL',
  'UNINSTALL',
])

/** MySQL and MariaDB. */
export function refuseBeyondReadingMysql(sql: string): void {
  // What's in /*! … */ and /*M! … */ runs: read as the statement's own text.
  const text = sql.replace(/\/\*M?!\d*/g, ' ').replace(/\*\//g, ' ')
  const word = mysqlFirstWord(text)
  if (MYSQL_STATEMENTS.has(word)) {
    refuse(`${word} acts on the server itself, not on what this database holds.`)
  }
  if (
    word === 'SET' &&
    /\b(GLOBAL|PERSIST|PERSIST_ONLY)\b|@@\s*(global|persist|persist_only)\s*\./i.test(text)
  ) {
    refuse('SET GLOBAL and SET PERSIST change the server for every connection.')
  }
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(text)) {
    refuse(
      'INTO OUTFILE and INTO DUMPFILE write a file on the database’s server. A statement that only mentions them is refused as well.',
    )
  }
  if (/\bLOAD_FILE\s*\(/i.test(text)) {
    refuse(
      'LOAD_FILE reads a file on the database’s server. A statement that only mentions it is refused as well.',
    )
  }
}

/** The first word past spaces and comments (-- , #, and blocks), in capitals. */
function mysqlFirstWord(text: string): string {
  let at = 0
  for (;;) {
    while (/\s/.test(text[at] ?? '')) at += 1
    if (text.startsWith('#', at) || /^--(\s|$)/.test(text.slice(at, at + 3))) {
      const end = text.indexOf('\n', at)
      if (end === -1) return ''
      at = end + 1
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2)
      if (end === -1) return ''
      at = end + 2
    } else break
  }
  return (/^[A-Za-z_]+/.exec(text.slice(at, at + 64))?.[0] ?? '').toUpperCase()
}
