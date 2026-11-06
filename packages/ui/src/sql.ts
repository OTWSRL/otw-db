/** One statement of an editor's text, and where it is in it. */
export interface Statement {
  text: string
  /** Offsets in the whole text: `text` is `whole.slice(from, to)`. */
  from: number
  to: number
}

/**
 * The statements in `sql`, split at semicolons that aren't inside a string ('…', E'…'), a quoted
 * name ("…"), a dollar-quoted body ($$…$$, $fn$…$fn$) or a comment (-- …, /* … *\/, which nest in
 * PostgreSQL). Each is trimmed; empty ones (a stray ;) are left out.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const raw = sql.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !onlyComments(text)) {
      statements.push({ text, from: start + lead, to: start + lead + text.length })
    }
  }
  while (i < sql.length) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
    } else if (c === '/' && next === '*') {
      i = skipBlockComment(sql, i)
    } else if (c === "'") {
      // E'…' strings take backslash escapes; others double the quote.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      i = skipQuoted(sql, i, "'", escapes)
    } else if (c === '"') {
      i = skipQuoted(sql, i, '"', false)
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      // $1 is a parameter, and a$b$ a name, not a quote.
      if (tag && !/[\w$]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        i = end === -1 ? sql.length : end + tag[0].length
      } else i++
    } else if (c === ';') {
      push(i)
      start = i + 1
      i++
    } else i++
  }
  push(sql.length)
  return statements
}

function skipQuoted(sql: string, i: number, quote: string, escapes: boolean): number {
  let j = i + 1
  while (j < sql.length) {
    if (escapes && sql[j] === '\\') j += 2
    else if (sql[j] === quote) {
      if (sql[j + 1] === quote) j += 2
      else return j + 1
    } else j++
  }
  return sql.length
}

function skipBlockComment(sql: string, i: number): number {
  let depth = 0
  let j = i
  while (j < sql.length) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      depth++
      j += 2
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      depth--
      j += 2
      if (depth === 0) return j
    } else j++
  }
  return sql.length
}

/** Whether `text` is comments and space only, which a database would refuse as empty. */
function onlyComments(text: string): boolean {
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) i++
    else if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end + 1
    } else if (text.startsWith('/*', i)) i = skipBlockComment(text, i)
    else return false
  }
  return true
}

/**
 * The statement to run for a cursor at `offset`, as TablePlus's Run Current: the one the cursor
 * is in, or else the last one before it (the cursor sits after its semicolon), or else the first.
 */
export function statementAt(statements: readonly Statement[], offset: number): Statement | null {
  let before: Statement | null = null
  for (const statement of statements) {
    if (offset >= statement.from && offset <= statement.to) return statement
    if (statement.to < offset) before = statement
  }
  return before ?? statements[0] ?? null
}

/** Starts with a word that changes data or schema: worth a second look on production. */
const WRITES =
  /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|copy|call|do|lock|import|security)\b/i

/** Whether a statement looks like a write (best effort, for confirmation, never for safety). */
export function looksLikeWrite(sql: string): boolean {
  return WRITES.test(stripLeadingComments(sql))
}

function stripLeadingComments(sql: string): string {
  let text = sql.trimStart()
  for (;;) {
    if (text.startsWith('--')) {
      const end = text.indexOf('\n')
      text = end === -1 ? '' : text.slice(end + 1).trimStart()
    } else if (text.startsWith('/*')) {
      text = text.slice(skipBlockComment(text, 0)).trimStart()
    } else return text
  }
}
