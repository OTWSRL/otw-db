import { useEffect, useRef, useState } from 'react'
import type {
  ApiError,
  ExportFormat,
  Filter,
  ResultSet,
  TableDetail,
  TableSummary,
} from '../api.ts'
import {
  NOTHING_STAGED,
  rowId,
  stagedCount,
  stagedReducer,
  toChanges,
  type Staged,
  type StagedAction,
} from '../edits.ts'
import { ConfirmDialog } from '../ui/Dialog.tsx'
import { download, ExportMenu } from '../ui/ExportMenu.tsx'
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
  const [staged, setStaged] = useState<Staged>(NOTHING_STAGED)
  const [undo, setUndo] = useState<Staged[]>([])
  const [review, setReview] = useState<{
    statements: string[]
    error?: ApiError
    saving?: boolean
  } | null>(null)
  const [saved, setSaved] = useState(0)
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
  const request = JSON.stringify({ limit, offset, order, filters, refreshKey, saved })
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

  const loaded = result?.rows ?? []
  const gridColumns = result?.columns ?? detail?.columns ?? []
  const names = gridColumns.map((c) => c.name)
  const primaryKey = detail?.primaryKey ?? []
  // Edits need a table to write to, a row to name, and a connection that may write.
  const editable =
    connection.access === 'write' &&
    primaryKey.length > 0 &&
    (detail?.kind === 'table' || detail?.kind === 'partitioned-table')
  const ids = loaded.map((row) => rowId(primaryKey, names, row))
  // What the grid shows: the page with its staged edits, then the new rows.
  const shown = [
    ...loaded.map((row, i) => {
      const update = ids[i] && staged.updates[ids[i]!.id]
      return update ? names.map((c, j) => (c in update.values ? update.values[c]! : row[j]!)) : row
    }),
    ...staged.inserts.map((insert) => names.map((c) => insert.values[c] ?? null)),
  ]
  const locked = new Set(
    names.flatMap((c, i) => {
      const column = detail?.columns.find((d) => d.name === c)
      return column?.generated && column.generated !== 'by default' ? [i] : []
    }),
  )
  const changes = stagedCount(staged)

  useEffect(() => {
    if (!active) return
    const row = selected ? shown[selected.row] : undefined
    showRow(row ? { columns: gridColumns, values: row } : null)
    // shown and gridColumns follow from result, staged and detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, result, staged, detail, selected, showRow])

  function stage(action: StagedAction) {
    setUndo((u) => [...u.slice(-99), staged])
    setStaged((s) => stagedReducer(s, action))
  }

  function edit(cell: Cell, value: string | null) {
    const column = names[cell.col]!
    if (cell.row >= loaded.length) {
      const insert = staged.inserts[cell.row - loaded.length]
      if (insert) stage({ type: 'edit-new', id: insert.id, column, value })
      return
    }
    const id = ids[cell.row]
    if (id)
      stage({ type: 'edit', ...id, column, value, original: loaded[cell.row]![cell.col] ?? null })
  }

  function deleteRow(row: number) {
    if (row >= loaded.length) {
      const insert = staged.inserts[row - loaded.length]
      if (insert) stage({ type: 'remove-new', id: insert.id })
      return
    }
    const id = ids[row]
    if (!id) return
    stage(id.id in staged.deletes ? { type: 'undelete', id: id.id } : { type: 'delete', ...id })
  }

  function addRow() {
    stage({ type: 'add' })
    setView('data')
    const first = names.findIndex((_, i) => !locked.has(i))
    setSelected({ row: loaded.length + staged.inserts.length, col: Math.max(0, first) })
  }

  function discard() {
    if (!changes) return
    setUndo((u) => [...u.slice(-99), staged])
    setStaged(NOTHING_STAGED)
  }

  const target = { connection: connection.name, schema, table }

  async function startReview() {
    if (!changes || review) return
    try {
      const { statements } = await api.apply({
        ...target,
        changes: toChanges(staged),
        dryRun: true,
      })
      setReview({ statements })
    } catch (e) {
      setError(e as ApiError)
    }
  }

  async function commit() {
    if (!review) return
    setReview({ ...review, saving: true })
    const started = performance.now()
    try {
      const { statements } = await api.apply({ ...target, changes: toChanges(staged) })
      log({
        statement: statements.join(';\n'),
        durationMs: Math.round(performance.now() - started),
      })
      setStaged(NOTHING_STAGED)
      setUndo([])
      setReview(null)
      setSaved((n) => n + 1)
    } catch (e) {
      log({ statement: `${changes} changes to ${name}`, error: (e as Error).message })
      setReview({ ...review, saving: false, error: e as ApiError })
    }
  }

  async function exportAs(format: ExportFormat) {
    try {
      const { blob, filename } = await api.exportTable({ ...target, filters, order, format })
      download(blob, filename)
    } catch (e) {
      setError(e as ApiError)
    }
  }

  // ⌘S reviews the staged edits, ⌘Z steps back; not while typing in a field.
  useEffect(() => {
    if (!active || !editable) return
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.defaultPrevented) return
      // The element itself, even inside a shadow root, where event.target is the host.
      const target = (event.composedPath()[0] ?? event.target) as HTMLElement
      const typing = target.closest?.('input, textarea, select, [contenteditable="true"]')
      if (event.key === 's') {
        event.preventDefault()
        void startReview()
      } else if (event.key === 'z' && !event.shiftKey && !typing && undo.length) {
        event.preventDefault()
        setStaged(undo.at(-1)!)
        setUndo(undo.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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
  const rows = loaded

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
          columns={gridColumns}
          rows={shown}
          firstRow={offset + 1}
          sort={sort}
          onSort={sortBy}
          selected={selected}
          onSelect={setSelected}
          {...(editable
            ? {
                onEdit: edit,
                onDeleteRow: deleteRow,
                lockedColumns: locked,
                rowState: (row: number) =>
                  row >= loaded.length
                    ? 'inserted'
                    : ids[row] && ids[row]!.id in staged.deletes
                      ? 'deleted'
                      : null,
                cellState: (row: number, col: number) => {
                  const column = names[col]!
                  if (row >= loaded.length) {
                    return column in (staged.inserts[row - loaded.length]?.values ?? {})
                      ? 'changed'
                      : 'default'
                  }
                  const update = ids[row] && staged.updates[ids[row]!.id]
                  return update && column in update.values ? 'changed' : null
                },
              }
            : {})}
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
        {editable && (
          <button type="button" className="button" onClick={addRow}>
            <Icon name="plus" size={12} /> Row
          </button>
        )}
        {changes > 0 && (
          <>
            <span className="changes" aria-live="polite">
              {changes === 1 ? '1 change' : `${changes} changes`}
            </span>
            <button type="button" className="button" onClick={discard}>
              Discard
            </button>
            <button type="button" className="button primary" onClick={() => void startReview()}>
              Commit
            </button>
          </>
        )}
        {connection.access === 'write' && detail && !editable && (
          <span title="Rows are named by their primary key to change them">
            Read-only: no primary key
          </span>
        )}
        <span className="spacer" />
        <ExportMenu formats={['csv', 'json', 'sql']} onExport={exportAs} />
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
      {review && (
        <ConfirmDialog
          title={connection.tag === 'production' ? 'Commit to production?' : 'Commit changes?'}
          confirmLabel="Commit"
          danger={connection.tag === 'production'}
          busy={review.saving}
          onCancel={() => setReview(null)}
          onConfirm={() => void commit()}
        >
          <p>
            {review.statements.length === 1
              ? 'This statement runs'
              : `These ${review.statements.length} statements run`}{' '}
            in one transaction: all of them, or none.
          </p>
          <pre>{review.statements.join(';\n') + ';'}</pre>
          {review.error && (
            <div className="notice" role="alert">
              {review.error.message}
            </div>
          )}
        </ConfirmDialog>
      )}
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
