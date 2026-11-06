import { csvHeader, csvLine, jsonObject } from './format.ts'
import type { ExportFormat, SqlDialect } from './types.ts'

/** Rows as a driver hands them over for an export: a batch at a time, names first. */
export interface ExportBatch {
  columns: readonly { name: string }[]
  rows: readonly (readonly (string | null)[])[]
}

/** Each export format's media type and file extension, for the download's headers. */
export const EXPORT_TYPES: Record<ExportFormat, { type: string; extension: string }> = {
  csv: { type: 'text/csv; charset=utf-8', extension: 'csv' },
  json: { type: 'application/json; charset=utf-8', extension: 'json' },
  sql: { type: 'application/sql; charset=utf-8', extension: 'sql' },
}

/**
 * The batches as a file in `format`, streamed as they come, so a table of any size passes
 * through without being held whole. `done` hears how many rows went out, or why it stopped.
 *
 * - CSV: a header line, then RFC 4180 rows. NULL is an empty field and an empty string a quoted
 *   one (""), as PostgreSQL's COPY reads them.
 * - JSON: an array of objects, each value a string or null, as the database wrote it.
 * - SQL: an INSERT a row, in the driver's own quoting.
 */
export function exportStream(
  format: ExportFormat,
  batches: AsyncIterator<ExportBatch>,
  target: { schema: string; table: string },
  dialect: SqlDialect,
  done: (rows: number, error?: Error) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let rows = 0
  let first = true
  let columns: readonly { name: string }[] = []
  const table = `${dialect.identifier(target.schema)}.${dialect.identifier(target.table)}`

  function chunk(batch: ExportBatch): string {
    let out = ''
    if (first) {
      columns = batch.columns
      if (format === 'csv') out += csvHeader(columns.map((c) => c.name))
      if (format === 'json') out += '['
    }
    for (const row of batch.rows) {
      if (format === 'csv') out += csvLine(row)
      else if (format === 'json') {
        const object = jsonObject(
          columns.map((c) => c.name),
          row,
        )
        out += `${first && rows === 0 ? '\n' : ',\n'}${JSON.stringify(object)}`
      } else {
        const names = columns.map((c) => dialect.identifier(c.name)).join(', ')
        out += `INSERT INTO ${table} (${names}) VALUES (${row.map(dialect.literal).join(', ')});\n`
      }
      rows++
    }
    first = false
    return out
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await batches.next()
        if (next.done) {
          if (format === 'json') controller.enqueue(encoder.encode(first ? '[]\n' : '\n]\n'))
          controller.close()
          done(rows)
          return
        }
        controller.enqueue(encoder.encode(chunk(next.value)))
      } catch (error) {
        done(rows, error as Error)
        controller.error(error)
      }
    },
    async cancel() {
      // The browser stopped reading: let the driver close its cursor and connection.
      await batches.return?.()
      done(rows, new Error('The download was stopped.'))
    },
  })
}
