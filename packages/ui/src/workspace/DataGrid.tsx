import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

export interface GridColumn {
  name: string
  type: string
}

export interface Cell {
  row: number
  col: number
}

export interface Sort {
  column: string
  descending: boolean
}

interface Props {
  columns: readonly GridColumn[]
  rows: readonly (readonly (string | null)[])[]
  /** The number shown on the first row: 301 on the second page of 300. */
  firstRow?: number
  sort?: Sort | null
  /** Clicking a header; without it, headers don't sort. */
  onSort?(column: string): void
  selected: Cell | null
  onSelect(cell: Cell): void
  label: string
  /**
   * Makes the grid editable: Enter, F2, a double-click or typing edits a cell; Enter or Tab keeps
   * the edit, Escape drops it; ⌘⌫ sets NULL.
   */
  onEdit?(cell: Cell, value: string | null): void
  /** Delete or Backspace on a selected row. */
  onDeleteRow?(row: number): void
  /** Columns no one may edit, as an identity's GENERATED ALWAYS. */
  lockedColumns?: ReadonlySet<number>
  /** A row added or to be deleted, for its color. */
  rowState?(row: number): 'inserted' | 'deleted' | null
  /** A cell changed from the database's value, or a new row's that takes its default. */
  cellState?(row: number, col: number): 'changed' | 'default' | null
}

const ROW = 24
const HEAD = 26
const NUMBER = 52
const MIN_WIDTH = 64
const MAX_WIDTH = 360
/** Longer values are cut for the cell; the row panel shows them whole. */
const SHOWN = 300

/**
 * A spreadsheet-like grid: rows and columns virtualized (only what's on screen is drawn), a row
 * number column that stays put, sortable and resizable headers, arrow keys to move, ⌘C to copy.
 */
export function DataGrid({
  columns,
  rows,
  firstRow = 1,
  sort,
  onSort,
  selected,
  onSelect,
  label,
  onEdit,
  onDeleteRow,
  lockedColumns,
  rowState,
  cellState,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [editing, setEditingState] = useState<{ cell: Cell; draft: string } | null>(null)
  // What's being edited now, for the blur that follows Enter: the edit is kept once, not twice.
  const editingNow = useRef<{ cell: Cell; draft: string } | null>(null)
  const setEditing = (next: { cell: Cell; draft: string } | null) => {
    editingNow.current = next
    setEditingState(next)
  }
  const [widths, setWidths] = useState(() => fit(columns, rows))
  // New columns (another table, another result) get widths of their own, fitted again once the
  // first rows arrive: a table's columns show before its rows do.
  const shape = `${columns.map((c) => c.name).join('\u0000')}\u0000${rows.length > 0}`
  const [fitted, setFitted] = useState(shape)
  if (fitted !== shape) {
    setFitted(shape)
    setWidths(fit(columns, rows))
  }

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => widths[i] ?? 120,
    overscan: 4,
  })
  useEffect(() => columnVirtualizer.measure(), [widths, columnVirtualizer])

  const width = NUMBER + columnVirtualizer.getTotalSize()
  const visibleColumns = columnVirtualizer.getVirtualItems()

  function move(cell: Cell) {
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, cell.row)),
      col: Math.max(0, Math.min(columns.length - 1, cell.col)),
    }
    onSelect(next)
    rowVirtualizer.scrollToIndex(next.row)
    columnVirtualizer.scrollToIndex(next.col)
  }

  const editable = (cell: Cell) =>
    !!onEdit && !lockedColumns?.has(cell.col) && rowState?.(cell.row) !== 'deleted'

  function startEditing(cell: Cell, draft?: string) {
    if (!editable(cell)) return
    setEditing({ cell, draft: draft ?? rows[cell.row]?.[cell.col] ?? '' })
  }

  /** Keeps the edit (or NULL), then moves on as the key says. */
  function finishEditing(value: string | null | undefined, then?: Cell) {
    const current = editingNow.current
    if (!current) return
    const { cell } = current
    setEditing(null)
    if (value !== undefined && value !== (rows[cell.row]?.[cell.col] ?? null)) onEdit?.(cell, value)
    if (then) move(then)
    scroller.current?.focus()
  }

  function editorKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (!editing) return
    event.stopPropagation()
    const { row, col } = editing.cell
    const draft = event.currentTarget.value
    if (event.key === 'Enter') {
      event.preventDefault()
      finishEditing(draft, { row: row + 1, col })
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finishEditing(draft, { row, col: col + (event.shiftKey ? -1 : 1) })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finishEditing(undefined)
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      finishEditing(null)
    }
  }

  function keys(event: KeyboardEvent) {
    if (!rows.length || !columns.length) return
    const at = selected ?? { row: 0, col: 0 }
    const mod = event.metaKey || event.ctrlKey
    if (onEdit && selected) {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault()
        startEditing(selected)
        return
      }
      if (event.key === 'Backspace' && mod) {
        event.preventDefault()
        if (editable(selected)) onEdit(selected, null)
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && onDeleteRow) {
        event.preventDefault()
        onDeleteRow(selected.row)
        return
      }
      // Typing starts an edit with what was typed, as in a spreadsheet.
      if (event.key.length === 1 && !mod && !event.altKey) {
        event.preventDefault()
        startEditing(selected, event.key)
        return
      }
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 240) / ROW) - 1)
    const moves: Record<string, Cell> = {
      ArrowUp: { row: at.row - 1, col: at.col },
      ArrowDown: { row: at.row + 1, col: at.col },
      ArrowLeft: { row: at.row, col: at.col - 1 },
      ArrowRight: { row: at.row, col: at.col + 1 },
      PageUp: { row: at.row - page, col: at.col },
      PageDown: { row: at.row + page, col: at.col },
      Home: { row: event.metaKey || event.ctrlKey ? 0 : at.row, col: 0 },
      End: {
        row: event.metaKey || event.ctrlKey ? rows.length - 1 : at.row,
        col: columns.length - 1,
      },
    }
    const target = moves[event.key]
    if (target) {
      event.preventDefault()
      move(target)
    } else if (event.key === 'c' && (event.metaKey || event.ctrlKey) && selected) {
      const value = rows[selected.row]?.[selected.col]
      event.preventDefault()
      void navigator.clipboard?.writeText(value ?? 'NULL')
    }
  }

  function resize(index: number, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const start = event.clientX
    const initial = widths[index] ?? 120
    const onMove = (e: globalThis.MouseEvent) => {
      const next = Math.max(MIN_WIDTH, initial + e.clientX - start)
      setWidths((w) => w.map((v, i) => (i === index ? next : v)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={scroller}
      className="grid"
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      tabIndex={0}
      onKeyDown={keys}
    >
      <div className="grid-inner" style={{ width, height: HEAD + rowVirtualizer.getTotalSize() }}>
        <div className="grid-head" role="row" aria-rowindex={1} style={{ width }}>
          <div className="head-cell number-cell" style={{ width: NUMBER }} />
          {visibleColumns.map((item) => {
            const column = columns[item.index]!
            const sorted = sort?.column === column.name ? sort : null
            return (
              <div
                key={item.key}
                className="head-cell"
                role="columnheader"
                aria-colindex={item.index + 1}
                aria-sort={sorted ? (sorted.descending ? 'descending' : 'ascending') : 'none'}
                title={`${column.name} (${column.type})`}
                style={{ left: NUMBER + item.start, width: item.size }}
                onClick={onSort ? () => onSort(column.name) : undefined}
              >
                <span>{column.name}</span>
                {sorted && <span aria-hidden>{sorted.descending ? '↓' : '↑'}</span>}
                <span className="type">{column.type}</span>
                <span className="resize" onMouseDown={(e) => resize(item.index, e)} />
              </div>
            )
          })}
        </div>
        {rowVirtualizer.getVirtualItems().map((rowItem) => {
          const row = rows[rowItem.index]!
          const isSelected = selected?.row === rowItem.index
          const state = rowState?.(rowItem.index)
          return (
            <div
              key={rowItem.key}
              className={`grid-row${isSelected ? ' selected' : ''}${state ? ` ${state}` : ''}`}
              role="row"
              aria-rowindex={rowItem.index + 2}
              aria-selected={isSelected}
              style={{ top: HEAD + rowItem.start, width }}
            >
              <div className="cell number-cell" style={{ width: NUMBER }}>
                {firstRow + rowItem.index}
              </div>
              {visibleColumns.map((item) =>
                editing?.cell.row === rowItem.index && editing.cell.col === item.index ? (
                  <input
                    key={item.key}
                    className="cell-editor"
                    aria-label={`Edit ${columns[item.index]!.name}`}
                    style={{ left: NUMBER + item.start, width: item.size }}
                    defaultValue={editing.draft}
                    autoFocus
                    onFocus={(e) =>
                      e.currentTarget.setSelectionRange(
                        e.currentTarget.value.length,
                        e.currentTarget.value.length,
                      )
                    }
                    onKeyDown={editorKeys}
                    onBlur={(e) => finishEditing(e.currentTarget.value)}
                  />
                ) : (
                  <CellView
                    key={item.key}
                    value={row[item.index] ?? null}
                    state={cellState?.(rowItem.index, item.index) ?? null}
                    left={NUMBER + item.start}
                    width={item.size}
                    column={item.index}
                    selected={isSelected && selected?.col === item.index}
                    onClick={() => {
                      onSelect({ row: rowItem.index, col: item.index })
                      scroller.current?.focus()
                    }}
                    onDoubleClick={() => startEditing({ row: rowItem.index, col: item.index })}
                  />
                ),
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CellView({
  value,
  state,
  left,
  width,
  column,
  selected,
  onClick,
  onDoubleClick,
}: {
  value: string | null
  state: 'changed' | 'default' | null
  left: number
  width: number
  column: number
  selected: boolean
  onClick(): void
  onDoubleClick(): void
}) {
  return (
    <div
      className={`cell${selected ? ' selected' : ''}${state ? ` ${state}` : ''}`}
      role="gridcell"
      aria-colindex={column + 1}
      aria-selected={selected}
      style={{ left, width }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {state === 'default' ? (
        <span className="null">DEFAULT</span>
      ) : value === null ? (
        <span className="null">NULL</span>
      ) : (
        shown(value)
      )}
    </div>
  )
}

/** A value as one line of a cell: its first line, cut short, with … where more follows. */
function shown(value: string): string {
  const newline = value.indexOf('\n')
  const line = newline === -1 ? value : value.slice(0, newline)
  if (line.length > SHOWN) return `${line.slice(0, SHOWN)}…`
  return newline === -1 ? line : `${line} …`
}

/** Each column wide enough for its header and its first rows' values, within limits. */
function fit(
  columns: readonly GridColumn[],
  rows: readonly (readonly (string | null)[])[],
): number[] {
  const sample = rows.slice(0, 50)
  return columns.map((column, i) => {
    const header = column.name.length + column.type.length * 0.8 + 3
    const longest = sample.reduce((max, row) => Math.max(max, Math.min(row[i]?.length ?? 4, 60)), 0)
    return Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.max(header, longest) * 7 + 18)))
  })
}
