import { DbAdminError } from '../errors.ts'
import type { Change, Filter } from '../types.ts'

/** How one database spells what the shared builders write. */
export interface Dialect {
  /** A name, quoted so any name is a name and never SQL. */
  identifier(name: string): string
  /** A value as a literal, for statements shown to people and SQL exports. */
  literal(value: string | null): string
  /** The placeholder for the `n`th parameter (from 1): `$1`, or `?`. */
  placeholder(n: number): string
  /** An expression's text, whatever its type: `x::text`, `CAST(x AS CHAR)`. */
  text(expression: string): string
  /** LIKE that ignores case: `ILIKE`, or `LIKE` where LIKE already does. */
  ilike: string
  /** The character that escapes % and _ in a LIKE pattern. */
  likeEscapeChar: string
  /** What makes it LIKE's escape where it isn't already: ` ESCAPE '\'` for SQLite. */
  likeEscape: string
  /**
   * Writes a value into the SQL itself rather than as a parameter, where the driver sends none
   * (MySQL's text protocol): a form that can't be read as SQL, whatever the server's settings.
   */
  inline?(value: string | null): string
  /**
   * `x IN (…)` for a list of values: PostgreSQL takes it as one array parameter, the others as one
   * parameter a value.
   */
  inList(
    expression: string,
    values: readonly string[],
    parameter: (value: unknown) => string,
  ): string
  /** An insert of nothing but defaults: `DEFAULT VALUES`, or MySQL's `() VALUES ()`. */
  insertDefaults: string
  /**
   * Bytes as the grid shows them, as a literal that is those bytes; null when the text isn't in
   * that form. Absent where the shown form is text the database reads as bytes itself.
   */
  bytes?(shown: string): string | null
  /**
   * What ends a SELECT that holds its rows until the transaction ends: ` FOR UPDATE`, or nothing
   * where a write transaction already holds the whole database (SQLite).
   */
  forUpdate: string
}

/** How long an export may wait between two batches for its reader, unless a driver is told otherwise. */
export const EXPORT_IDLE_MS = 300_000

/** Milliseconds as people read them: `10 s`, `0.3 s`. */
export function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} s`
}

/**
 * What an export says when it's ended because nobody read it. A browser that stays away mid-file
 * would otherwise hold what the export holds (a connection, a cursor's rows, a lock on the file)
 * for as long as it stays away.
 */
export function stalledExport(idleMs: number): DbAdminError {
  return new DbAdminError(
    `The export waited ${seconds(idleMs)} for its rows to be read, and was stopped so its connection is free for others.`,
    408,
    'export-stalled',
  )
}

/** No column holds bytes, or the database reads their shown form itself. */
const NO_BYTES: ReadonlySet<string> = new Set()

/**
 * Parameters as a builder adds them, with their placeholders. `bytes` names the columns that hold
 * bytes: a value for one of them, in the form the grid shows bytes in, goes into the SQL as the
 * bytes it stands for, not as those letters.
 */
export class Parameters {
  readonly values: unknown[] = []
  constructor(
    private readonly dialect: Dialect,
    private readonly bytes: ReadonlySet<string> = NO_BYTES,
  ) {}
  add = (value: unknown, column?: string): string => {
    if (column !== undefined && typeof value === 'string' && this.bytes.has(column)) {
      const literal = this.dialect.bytes?.(value)
      if (literal != null) return literal
    }
    if (this.dialect.inline) return this.dialect.inline(value as string | null)
    this.values.push(value)
    return this.dialect.placeholder(this.values.length)
  }
}

const COMPARISONS = new Set(['=', '<>', '<', '>', '<=', '>='])
const SEARCHES: Record<string, { not: boolean; pattern(value: string, escape: string): string }> = {
  contains: { not: false, pattern: (v, e) => `%${escapeLike(v, e)}%` },
  'not contains': { not: true, pattern: (v, e) => `%${escapeLike(v, e)}%` },
  'starts with': { not: false, pattern: (v, e) => `${escapeLike(v, e)}%` },
  'ends with': { not: false, pattern: (v, e) => `%${escapeLike(v, e)}` },
}

/**
 * The WHERE clause for the filters, every value a parameter. The database reads a parameter as
 * its column's type, so `price > '10'` compares numbers. Text searches (contains, starts with,
 * like) compare the column's text, whatever its type; all but `like` ignore case.
 */
export function where(
  dialect: Dialect,
  filters: readonly Filter[],
  parameters: Parameters,
): string {
  const conditions = filters.map(({ column, operator, value }) => {
    const name = dialect.identifier(column)
    // Compared with the column itself, so as the column's kind: bytes where it holds bytes.
    const add = (compared: unknown) => parameters.add(compared, column)
    if (COMPARISONS.has(operator)) return `${name} ${operator} ${add(value)}`
    switch (operator) {
      case 'is null':
        return `${name} IS NULL`
      case 'is not null':
        return `${name} IS NOT NULL`
      case 'in':
        return dialect.inList(name, value as readonly string[], add)
      case 'not in':
        return `NOT (${dialect.inList(name, value as readonly string[], add)})`
      case 'between':
      case 'not between': {
        const [low, high] = value as readonly string[]
        const not = operator === 'not between' ? 'NOT ' : ''
        return `${name} ${not}BETWEEN ${add(low)} AND ${add(high)}`
      }
      case 'like':
        return `${dialect.text(name)} LIKE ${parameters.add(value)}`
      case 'not like':
        return `${dialect.text(name)} NOT LIKE ${parameters.add(value)}`
    }
    const search = SEARCHES[operator]
    if (!search) throw new DbAdminError(`"${operator}" isn't a filter.`, 400, 'bad-request')
    const not = search.not ? 'NOT ' : ''
    const pattern = parameters.add(search.pattern(value as string, dialect.likeEscapeChar))
    return `${dialect.text(name)} ${not}${dialect.ilike} ${pattern}${dialect.likeEscape}`
  })
  return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
}

/** ORDER BY for the columns given, or nothing. */
export function orderBy(
  dialect: Dialect,
  order: readonly { column: string; descending?: boolean }[],
): string {
  if (!order.length) return ''
  const terms = order.map((o) => `${dialect.identifier(o.column)}${o.descending ? ' DESC' : ''}`)
  return ` ORDER BY ${terms.join(', ')}`
}

/** A LIKE pattern matching `value` as it is: its %, _ and escape character taken literally. */
function escapeLike(value: string, escape: string): string {
  return [...value]
    .map((c) => (c === '%' || c === '_' || c === escape ? `${escape}${c}` : c))
    .join('')
}

/** A change as SQL: the text with parameters to run, and with its values written in to show. */
export interface ChangeStatement {
  text: string
  values: (string | null)[]
  shown: string
  /** Updates and deletes must change exactly one row. */
  oneRow: boolean
  /**
   * For an update that says what its cells held when they were edited: the SELECT that reads
   * them now and holds the row until the transaction ends, and what they held, in its order.
   */
  check?: {
    text: string
    values: (string | null)[]
    columns: string[]
    original: (string | null)[]
  }
}

/**
 * SQL with its values: `build` writes the text, calling `value` where each one goes. They become
 * parameters to run, or go into the text where the driver sends none, and literals to show.
 */
function written(
  dialect: Dialect,
  bytes: ReadonlySet<string>,
  build: (value: (column: string, value: string | null) => string) => string,
): { text: string; values: (string | null)[]; shown: string } {
  const values: (string | null)[] = []
  const slots: { run: string; shown: string }[] = []
  // Placeholders are numbered here and swapped afterwards: `?` alone can't be told apart.
  const text = build((column, value) => {
    const literal = value !== null && bytes.has(column) ? (dialect.bytes?.(value) ?? null) : null
    if (literal !== null) slots.push({ run: literal, shown: literal })
    else if (dialect.inline) {
      slots.push({ run: dialect.inline(value), shown: dialect.literal(value) })
    } else {
      values.push(value)
      slots.push({ run: dialect.placeholder(values.length), shown: dialect.literal(value) })
    }
    return `\uE000${slots.length}\uE000`
  })
  // A private-use character: no SQL a driver builds contains one.
  const mark = /\uE000(\d+)\uE000/g
  return {
    text: text.replace(mark, (_, n: string) => slots[Number(n) - 1]!.run),
    values,
    shown: text.replace(mark, (_, n: string) => slots[Number(n) - 1]!.shown),
  }
}

/**
 * A change as the statement that makes it. `bytes` names the table's columns that hold bytes,
 * where the database doesn't read their shown form itself.
 */
export function changeStatement(
  dialect: Dialect,
  target: string,
  change: Change,
  bytes: ReadonlySet<string> = NO_BYTES,
): ChangeStatement {
  if (change.type === 'insert') {
    const columns = Object.keys(change.values)
    const statement = written(dialect, bytes, (value) =>
      columns.length
        ? `INSERT INTO ${target} (${columns.map(dialect.identifier).join(', ')}) VALUES (${columns.map((c) => value(c, change.values[c]!)).join(', ')})`
        : `INSERT INTO ${target} ${dialect.insertDefaults}`,
    )
    return { ...statement, oneRow: false }
  }
  const assignments =
    (value: (column: string, value: string | null) => string) =>
    (record: Readonly<Record<string, string | null>>) =>
      Object.entries(record).map(
        ([column, v]) => `${dialect.identifier(column)} = ${value(column, v)}`,
      )
  // SET before WHERE, in the order the SQL has them: `?` placeholders bind by position.
  const statement = written(dialect, bytes, (value) => {
    const set = change.type === 'update' ? assignments(value)(change.values).join(', ') : ''
    const key = assignments(value)(change.key).join(' AND ')
    return change.type === 'update'
      ? `UPDATE ${target} SET ${set} WHERE ${key}`
      : `DELETE FROM ${target} WHERE ${key}`
  })
  const original = change.type === 'update' ? change.original : undefined
  if (!original || !Object.keys(original).length) return { ...statement, oneRow: true }
  const columns = Object.keys(original)
  const { text, values } = written(
    dialect,
    bytes,
    (value) =>
      `SELECT ${columns.map(dialect.identifier).join(', ')} FROM ${target} WHERE ${assignments(value)(change.key).join(' AND ')}${dialect.forUpdate}`,
  )
  return {
    ...statement,
    oneRow: true,
    check: { text, values, columns, original: columns.map((c) => original[c] ?? null) },
  }
}

/**
 * Refuses an update whose cells no longer hold what they did when the person edited them.
 * `current` is the row the statement's check read, as the grid would show it, or nothing when the
 * row is gone. The check reads inside the update's transaction and holds the row, so what it sees
 * is what the update would overwrite.
 */
export function refuseChanged(
  dialect: Dialect,
  statement: ChangeStatement,
  current: readonly (string | null)[] | undefined,
): void {
  const check = statement.check
  if (!check) return
  if (!current) {
    throw new DbAdminError(
      `Nothing was saved: its row is gone or its key changed.\n${statement.shown}`,
      409,
      'conflict',
    )
  }
  const show = (value: string | null) => {
    const literal = dialect.literal(value)
    return literal.length > 200 ? `${literal.slice(0, 200)}…` : literal
  }
  check.columns.forEach((column, i) => {
    const now = current[i] ?? null
    if (now === check.original[i]) return
    throw new DbAdminError(
      `Nothing was saved: ${column} was changed by someone else meanwhile, from ${show(check.original[i]!)} to ${show(now)}.\n${statement.shown}`,
      409,
      'conflict',
    )
  })
}

/** A whole number for SQL text, which only ever takes numbers checked here. */
export function whole(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DbAdminError(`${value} isn't a whole number.`, 400, 'bad-request')
  }
  return value
}

/** A name in double quotes, as PostgreSQL and SQLite take them. */
export function doubleQuote(identifier: string): string {
  if (typeof identifier !== 'string' || !identifier || identifier.includes('\0')) {
    throw new DbAdminError(`"${identifier}" isn't a name.`, 400, 'bad-request')
  }
  return `"${identifier.replaceAll('"', '""')}"`
}
