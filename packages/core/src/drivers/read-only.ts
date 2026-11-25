import { DbAdminError } from '../errors.ts'
import { leadingWord } from '../words.ts'

/*
 * What read access runs of someone's own SQL. A read-only transaction keeps a statement from
 * changing rows; the server's files, its programs, its settings and its other connections aren't
 * rows, and a login that may touch them (a superuser, root, and PGlite, which has no other kind)
 * still can through a connection marked read-only: COPY … TO PROGRAM runs a command on the
 * database's server.
 *
 * So read access takes the statements that read, by their first word, and no others: what isn't
 * on the list isn't run, however it's written. Within a statement that reads, a function can
 * still reach past the database, and no list has every function: the ones that are known are
 * refused by name, wherever the name appears, in a string or a comment too, since a function
 * that runs SQL it's given could be handed the name in pieces. That refuses a statement that
 * only mentions one, which read access can live with. It's a guard, not a wall: a function the
 * database's owner wrote can do anything. A read-only connection is safe with a login that may
 * only read.
 */

function refuse(what: string): never {
  throw new DbAdminError(`This connection is read-only: ${what}`, 403, 'not-allowed')
}

const READS = 'Read access runs SELECT, WITH, VALUES, TABLE, SHOW and EXPLAIN'

/** The statements that read, on PostgreSQL. */
const POSTGRES_READS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN'])

/**
 * PostgreSQL's functions that read or write the server's files, act on the server or on its
 * other connections, open another connection, hold a lock for the session, or run SQL they're
 * given as text (through which any of the others could be named in pieces).
 */
const POSTGRES_NAMES = new RegExp(
  `\\b(${[
    // The server's files, read or written.
    'lo_export',
    'lo_import',
    'pg_read_\\w*file\\w*',
    'pg_ls_[a-z_]*dir\\w*',
    'pg_stat_file',
    'pg_file_\\w+',
    'pg_hba_file_rules',
    'pg_ident_file_mappings',
    'pg_show_all_file_settings',
    'pg_current_logfile',
    // The server itself, and its other connections.
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_log_backend_memory_contexts',
    'pg_log_standby_snapshot',
    'pg_reload_conf',
    'pg_rotate_logfile\\w*',
    'pg_switch_wal',
    'pg_promote',
    'pg_create_restore_point',
    'pg_backup_\\w+',
    'pg_start_backup',
    'pg_stop_backup',
    'pg_wal_replay_\\w+',
    'pg_stat_\\w*reset\\w*',
    'pg_create_\\w*replication_slot',
    'pg_copy_\\w*replication_slot',
    'pg_drop_replication_slot',
    'pg_replication_slot_advance',
    'pg_sync_replication_slots',
    'pg_replication_origin_(?:create|drop|advance|session_setup|session_reset|xact_setup|xact_reset)',
    'pg_logical_\\w+',
    // The session, which the next query on this connection shares.
    'pg_advisory_\\w+',
    'pg_try_advisory_\\w+',
    'set_config',
    'setseed',
    // Another connection, or SQL given as text, through which any of the above could be named
    // in pieces: built in, and from the extensions most often installed.
    'dblink\\w*',
    'query_to_xml\\w*',
    'cursor_to_xml\\w*',
    'ts_stat',
    'ts_rewrite',
    'crosstab\\w*',
    'connectby',
    'xpath_table',
  ].join('|')})\\b`,
  'i',
)

/** PostgreSQL, and PGlite, which is one. */
export function refuseBeyondReadingPostgres(sql: string): void {
  const word = leadingWord(sql)
  if (!POSTGRES_READS.has(word)) {
    refuse(
      word
        ? `${READS}, not ${word}. COPY, DO and LOAD among the others reach the server itself, which no transaction holds back.`
        : `${READS}.`,
    )
  }
  const name = POSTGRES_NAMES.exec(sql)?.[1]
  if (name) {
    refuse(
      `${name.toLowerCase()} reaches past the database’s rows: to the server’s files, the server itself, its other connections, or SQL of its own. A statement that only mentions it is refused as well.`,
    )
  }
  // A name spelled in escapes is a name this can't read.
  if (/(?<![A-Za-z0-9_$])U&\s*["']/i.test(sql)) {
    refuse('names and strings written with U& escapes aren’t taken here.')
  }
}

/** The statements that read, on MySQL and MariaDB. */
const MYSQL_READS = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'TABLE',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
])

const MYSQL_NAMES =
  /\b(asynchronous_connection_failover_\w+|group_replication_\w+|innodb_set_open_files_limit|innodb_redo_log_\w+|sys_exec|sys_eval)\b/i

/** MySQL and MariaDB. */
export function refuseBeyondReadingMysql(sql: string): void {
  // What's inside /*! … */ and /*M! … */ runs as SQL: a statement within a comment.
  if (/\/\*M?!/.test(sql)) refuse('comments that run as SQL (/*! … */) aren’t taken here.')
  const word = mysqlFirstWord(sql)
  if (!MYSQL_READS.has(word)) {
    refuse(
      word
        ? `${READS} (DESCRIBE too), not ${word}. KILL, SET GLOBAL and FLUSH among the others act on the server itself, which no transaction holds back.`
        : `${READS}.`,
    )
  }
  // Keywords and a function no SELECT can spell any other way: refused wherever they appear.
  const beyond = /\b(OUTFILE|DUMPFILE|LOAD_FILE)\b/i.exec(sql)?.[1]
  if (beyond) {
    refuse(
      `${beyond.toUpperCase()} reads or writes a file on the database’s server. A statement that only mentions it is refused as well.`,
    )
  }
  // Functions that change the server, which a SELECT may call and no transaction undoes.
  const acts = MYSQL_NAMES.exec(sql)?.[1]
  if (acts) {
    refuse(
      `${acts.toLowerCase()} changes the server itself. A statement that only mentions it is refused as well.`,
    )
  }
}

/** The first word past spaces, comments (-- , # and blocks) and brackets, in capitals. */
function mysqlFirstWord(text: string): string {
  let at = 0
  for (;;) {
    while (/[\s(;]/.test(text[at] ?? '')) at += 1
    // `--` starts a comment before a space, a control character, or the end: MySQL's own rule.
    if (
      text.startsWith('#', at) ||
      (text.startsWith('--', at) && !(text.charCodeAt(at + 2) > 32))
    ) {
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
