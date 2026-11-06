/*
 * How rows are written to files, shared by the server's exports and the browser's (a query's
 * results). Plain functions, nothing from Node, so the browser app can take them as they are.
 */

/** A CSV line: RFC 4180 fields, NULL empty and an empty string "", as PostgreSQL's COPY reads. */
export function csvLine(values: readonly (string | null)[]): string {
  return `${values.map(csvValue).join(',')}\r\n`
}

/** The header line: column names, quoted as any field. */
export function csvHeader(names: readonly string[]): string {
  return `${names.map(csvField).join(',')}\r\n`
}

function csvValue(value: string | null): string {
  if (value === null) return ''
  return value === '' ? '""' : csvField(value)
}

function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** A row as a JSON object, names to values (text or null, as the database wrote them). */
export function jsonObject(
  names: readonly string[],
  values: readonly (string | null)[],
): Record<string, string | null> {
  const object: Record<string, string | null> = {}
  names.forEach((name, i) => (object[name] = values[i] ?? null))
  return object
}

/** A whole result as a CSV file. */
export function toCsv(
  names: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  return csvHeader(names) + rows.map(csvLine).join('')
}

/** A whole result as a JSON array of objects. */
export function toJson(
  names: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  return `${JSON.stringify(
    rows.map((row) => jsonObject(names, row)),
    null,
    2,
  )}\n`
}
