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
}

/** Parameters as a builder adds them, with their placeholders. */
export class Parameters {
  readonly values: unknown[] = []
  constructor(private readonly dialect: Dialect) {}
  add = (value: unknown): string => {
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
    if (COMPARISONS.has(operator)) return `${name} ${operator} ${parameters.add(value)}`
    switch (operator) {
      case 'is null':
        return `${name} IS NULL`
      case 'is not null':
        return `${name} IS NOT NULL`
      case 'in':
        return dialect.inList(name, value as readonly string[], parameters.add)
      case 'not in':
        return `NOT (${dialect.inList(name, value as readonly string[], parameters.add)})`
      case 'between':
      case 'not between': {
        const [low, high] = value as readonly string[]
        const not = operator === 'not between' ? 'NOT ' : ''
        return `${name} ${not}BETWEEN ${parameters.add(low)} AND ${parameters.add(high)}`
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
}

export function changeStatement(dialect: Dialect, target: string, change: Change): ChangeStatement {
  const values: (string | null)[] = []
  const shownValues: string[] = []
  const runValues: string[] = []
  // Placeholders are numbered here and swapped afterwards: `?` alone can't be told apart.
  const parameter = (value: string | null) => {
    values.push(value)
    shownValues.push(dialect.literal(value))
    runValues.push(dialect.inline ? dialect.inline(value) : dialect.placeholder(values.length))
    return `\uE000${values.length}\uE000`
  }
  const assignments = (record: Readonly<Record<string, string | null>>) =>
    Object.entries(record).map(
      ([column, value]) => `${dialect.identifier(column)} = ${parameter(value)}`,
    )
  let text: string
  if (change.type === 'insert') {
    const columns = Object.keys(change.values)
    text = columns.length
      ? `INSERT INTO ${target} (${columns.map(dialect.identifier).join(', ')}) VALUES (${columns.map((c) => parameter(change.values[c]!)).join(', ')})`
      : `INSERT INTO ${target} ${dialect.insertDefaults}`
  } else {
    // SET before WHERE, in the order the SQL has them: `?` placeholders bind by position.
    const set = change.type === 'update' ? assignments(change.values).join(', ') : ''
    const key = assignments(change.key).join(' AND ')
    text =
      change.type === 'update'
        ? `UPDATE ${target} SET ${set} WHERE ${key}`
        : `DELETE FROM ${target} WHERE ${key}`
  }
  // A private-use character: no SQL a driver builds contains one.
  const mark = /\uE000(\d+)\uE000/g
  return {
    text: text.replace(mark, (_, n: string) => runValues[Number(n) - 1]!),
    values: dialect.inline ? [] : values,
    shown: text.replace(mark, (_, n: string) => shownValues[Number(n) - 1]!),
    oneRow: change.type !== 'insert',
  }
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
