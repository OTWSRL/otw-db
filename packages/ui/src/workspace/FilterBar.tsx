import { useEffect, useRef } from 'react'
import type { Filter } from '../api.ts'
import { Icon } from '../ui/icons.tsx'

/** A filter as the bar edits it: values as typed, before they're checked. */
export interface DraftFilter {
  column: string
  operator: Filter['operator']
  value: string
  /** The second value, for between. */
  to: string
}

export const OPERATORS: readonly { value: Filter['operator']; label: string }[] = [
  { value: '=', label: '=' },
  { value: '<>', label: '≠' },
  { value: '<', label: '<' },
  { value: '>', label: '>' },
  { value: '<=', label: '≤' },
  { value: '>=', label: '≥' },
  { value: 'contains', label: 'Contains' },
  { value: 'not contains', label: 'Not contains' },
  { value: 'starts with', label: 'Starts with' },
  { value: 'ends with', label: 'Ends with' },
  { value: 'in', label: 'In' },
  { value: 'not in', label: 'Not in' },
  { value: 'between', label: 'Between' },
  { value: 'not between', label: 'Not between' },
  { value: 'like', label: 'Like' },
  { value: 'not like', label: 'Not like' },
  { value: 'is null', label: 'Is null' },
  { value: 'is not null', label: 'Is not null' },
]

const takesNothing = (o: Filter['operator']) => o === 'is null' || o === 'is not null'
const takesTwo = (o: Filter['operator']) => o === 'between' || o === 'not between'
const takesList = (o: Filter['operator']) => o === 'in' || o === 'not in'

export function newFilter(column: string): DraftFilter {
  return { column, operator: '=', value: '', to: '' }
}

/** The bar's conditions as the API takes them: `in` lists split at commas. */
export function toFilters(drafts: readonly DraftFilter[]): Filter[] {
  return drafts.map(({ column, operator, value, to }) => {
    if (takesNothing(operator)) return { column, operator }
    if (takesTwo(operator)) return { column, operator, value: [value, to] }
    if (takesList(operator)) {
      return {
        column,
        operator,
        value: value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      }
    }
    return { column, operator, value }
  })
}

interface Props {
  columns: readonly string[]
  drafts: readonly DraftFilter[]
  onChange(drafts: DraftFilter[]): void
  onApply(): void
  onClose(): void
  /** Bumped to move the focus into the bar (⌘F). */
  focusKey: number
}

/** TablePlus's filter bar: a row per condition (column, operator, value), applied together. */
export function FilterBar({ columns, drafts, onChange, onApply, onClose, focusKey }: Props) {
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [focusKey])

  const update = (index: number, change: Partial<DraftFilter>) =>
    onChange(drafts.map((d, i) => (i === index ? { ...d, ...change } : d)))

  return (
    <form
      className="filters"
      aria-label="Filters"
      onSubmit={(e) => {
        e.preventDefault()
        onApply()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      {drafts.map((draft, index) => (
        <div className="filter-row" key={index}>
          <select
            className="select"
            aria-label="Column"
            value={draft.column}
            onChange={(e) => update(index, { column: e.target.value })}
          >
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Operator"
            value={draft.operator}
            onChange={(e) => update(index, { operator: e.target.value as Filter['operator'] })}
          >
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!takesNothing(draft.operator) && (
            <input
              ref={index === 0 ? first : undefined}
              className="input value"
              aria-label="Value"
              placeholder={takesList(draft.operator) ? 'a, b, c' : 'Value'}
              value={draft.value}
              onChange={(e) => update(index, { value: e.target.value })}
            />
          )}
          {takesTwo(draft.operator) && (
            <input
              className="input value"
              aria-label="And"
              placeholder="and"
              value={draft.to}
              onChange={(e) => update(index, { to: e.target.value })}
            />
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Remove condition"
            onClick={() => onChange(drafts.filter((_, i) => i !== index))}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add condition"
            onClick={() =>
              onChange([
                ...drafts.slice(0, index + 1),
                newFilter(draft.column),
                ...drafts.slice(index + 1),
              ])
            }
          >
            <Icon name="plus" />
          </button>
          {index === 0 && (
            <div className="filter-actions">
              <button type="submit" className="button primary">
                Apply
              </button>
              <button type="button" className="button" onClick={onClose}>
                Clear
              </button>
            </div>
          )}
        </div>
      ))}
    </form>
  )
}
