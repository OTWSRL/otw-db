import { useEffect, useRef, useState } from 'react'
import type { ApiError, Filter, ResultSet, TableDetail, TableSummary } from '../api.ts'
import { Icon } from '../ui/icons.tsx'
import { useWorkspace } from './context.ts'
import { DataGrid, type Cell, type Sort } from './DataGrid.tsx'
import { FilterBar, newFilter, toFilters, type DraftFilter } from './FilterBar.tsx'
import { StructureView } from './StructureView.tsx'

const PAGE_SIZES = [100, 300, 1000] as const

interface Props {
  schema: string
  table: string
  summary: TableSummary | undefined
  active: boolean
}

/** A table's tab: its rows a page at a time, filtered and sorted, or its structure. */
export function TableTab({ schema, table, summary, active }: Props) {
  const { api, connection, log, showRow, refreshKey, filterKey } = useWorkspace()
  const [view, setView] = useState<'data' | 'structure'>('data')
  const [detail, setDetail] = useState<TableDetail | null>(null)
  const [result, setResult] = useState<ResultSet | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  /** The request the rows on screen answer; loading until it's the current one. */
  const [answered, setAnswered] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [limit, setLimit] = useState<number>(300)
  const [sort, setSort] = useState<Sort | null>(null)
  const [drafts, setDrafts] = useState<DraftFilter[] | null>(null)
  const [filters, setFilters] = useState<Filter[]>([])
  const [count, setCount] = useState<number | null>(null)
  const [selected, setSelected] = useState<Cell | null>(null)
  const [focusFilters, setFocusFilters] = useState(0)
  const name = `${schema}.${table}`

  useEffect(() => {
    let current = true
    api.table(connection.name, schema, table).then(
      (d) => current && setDetail(d),
      (e: unknown) => current && setError(e as ApiError),
    )
    return () => {
      current = false
    }
  }, [api, connection.name, schema, table, refreshKey])

  // Rows in the primary key's order unless a header says otherwise, so pages don't shuffle.
  const order = sort
    ? [{ column: sort.column, descending: sort.descending }]
    : (detail?.primaryKey.map((column) => ({ column })) ?? [])
  // Everything the page depends on, as one value the effect below can compare.
  const request = JSON.stringify({ limit, offset, order, filters, refreshKey })
  const loading = detail !== null && answered !== request

  useEffect(() => {
    if (!detail) return
    const controller = new AbortController()
    const page = JSON.parse(request) as {
      limit: number
      offset: number
      order: { column: string; descending?: boolean }[]
      filters: Filter[]
    }
    const statement = describe(name, page.filters, page.limit, page.offset)
    const started = performance.now()
    api
      .rows({ connection: connection.name, schema, table, ...page }, controller.signal)
      .then(
        (rows) => {
          setResult(rows)
          setError(null)
          setSelected(null)
          log({ statement, durationMs: rows.durationMs })
        },
        (e: unknown) => {
          if (controller.signal.aborted) return
          setError(e as ApiError)
          log({
            statement,
            durationMs: Math.round(performance.now() - started),
            error: (e as Error).message,
          })
        },
      )
      .finally(() => !controller.signal.aborted && setAnswered(request))
    return () => controller.abort()
  }, [api, connection.name, schema, table, name, detail, request, log])

  // ⌘F in the workspace opens the bar of the tab in front.
  const seenFilterKey = useRef(filterKey)
  useEffect(() => {
    if (!active || filterKey === seenFilterKey.current) return
    seenFilterKey.current = filterKey
    setView('data')
    setDrafts((d) => d ?? [newFilter(detail?.columns[0]?.name ?? '')])
    setFocusFilters((n) => n + 1)
  }, [active, filterKey, detail])

  useEffect(() => {
    if (!active) return
    const row = result && selected ? result.rows[selected.row] : undefined
    showRow(row && result ? { columns: result.columns, values: row } : null)
  }, [active, result, selected, showRow])

  function sortBy(column: string) {
    // Ascending, then descending, then back to the table's own order.
    setSort((s) =>
      s?.column !== column
        ? { column, descending: false }
        : s.descending
          ? null
          : { column, descending: true },
    )
    setOffset(0)
  }

  function apply(next: DraftFilter[] | null) {
    setFilters(next ? toFilters(next) : [])
    setOffset(0)
    setCount(null)
  }

  async function countRows() {
    const started = performance.now()
    try {
      setCount(await api.count({ connection: connection.name, schema, table, filters }))
      log({
        statement: `SELECT count(*) FROM ${name}${filters.length ? ' WHERE …' : ''}`,
        durationMs: Math.round(performance.now() - started),
      })
    } catch (e) {
      setError(e as ApiError)
    }
  }

  const columns = detail?.columns.map((c) => c.name) ?? []
  const shownCount = count ?? (filters.length ? null : (summary?.estimatedRows ?? null))
  const rows = result?.rows ?? []

  return (
    <div className="tab-body" hidden={!active}>
      {drafts && view === 'data' && (
        <FilterBar
          columns={columns}
          drafts={drafts}
          onChange={(d) => (d.length ? setDrafts(d) : (setDrafts(null), apply(null)))}
          onApply={() => apply(drafts)}
          onClose={() => {
            setDrafts(null)
            apply(null)
          }}
          focusKey={focusFilters}
        />
      )}
      {error && (
        <div className="notice" role="alert">
          {error.message}
          {error.detail && <div className="detail">{error.detail}</div>}
        </div>
      )}
      {view === 'structure' ? (
        detail && <StructureView table={detail} />
      ) : (
        <DataGrid
          label={name}
          columns={result?.columns ?? detail?.columns ?? []}
          rows={rows}
          firstRow={offset + 1}
          sort={sort}
          onSort={sortBy}
          selected={selected}
          onSelect={setSelected}
        />
      )}
      <div className="bottombar">
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'data'} onClick={() => setView('data')}>
            Data
          </button>
          <button
            type="button"
            aria-pressed={view === 'structure'}
            onClick={() => setView('structure')}
          >
            Structure
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Filter"
          aria-pressed={drafts !== null}
          onClick={() => {
            setView('data')
            if (drafts) {
              setDrafts(null)
              apply(null)
            } else setDrafts([newFilter(columns[0] ?? '')])
          }}
        >
          <Icon name="filter" />
        </button>
        <span className="spacer" />
        {view === 'data' && (
          <>
            <span aria-live="polite">
              {loading
                ? 'Loading…'
                : rows.length
                  ? `Rows ${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()}`
                  : 'No rows'}
              {shownCount !== null &&
                ` of ${count === null ? '~' : ''}${shownCount.toLocaleString()}`}
            </span>
            <button type="button" className="button" onClick={countRows}>
              Count
            </button>
            <div className="pager">
              <button
                type="button"
                className="icon-button"
                aria-label="Previous page"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - limit))}
              >
                <Icon name="left" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Next page"
                disabled={!result?.truncated}
                onClick={() => setOffset((o) => o + limit)}
              >
                <Icon name="right" />
              </button>
              <select
                className="select"
                aria-label="Rows per page"
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value))
                  setOffset(0)
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} rows
                  </option>
                ))}
              </select>
            </div>
            {result && <span>{result.durationMs} ms</span>}
          </>
        )}
      </div>
    </div>
  )
}

/** The page's statement as the console shows it; the server builds the real one. */
function describe(name: string, filters: readonly Filter[], limit: number, offset: number): string {
  const where = filters.length
    ? ` WHERE ${filters.map((f) => `${f.column} ${f.operator}${f.value === undefined ? '' : ' …'}`).join(' AND ')}`
    : ''
  return `SELECT * FROM ${name}${where} LIMIT ${limit} OFFSET ${offset}`
}
