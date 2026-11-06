import { useMemo, useState } from 'react'
import type { TableSummary } from '../api.ts'
import type { HistoryEntry } from '../history.ts'
import { Icon, kindIcon } from '../ui/icons.tsx'

const GROUPS: readonly { kinds: readonly string[]; title: string }[] = [
  { kinds: ['table', 'partitioned-table'], title: 'Tables' },
  { kinds: ['view'], title: 'Views' },
  { kinds: ['materialized-view'], title: 'Materialized views' },
  { kinds: ['foreign-table'], title: 'Foreign tables' },
]

interface Props {
  tables: readonly TableSummary[] | null
  schema: string
  onSchema(schema: string): void
  current: { schema: string; table: string } | null
  onOpen(table: TableSummary): void
  history: readonly HistoryEntry[]
  onHistory(sql: string): void
}

/** The left sidebar: a schema, a search, the schema's tables by kind; or the SQL history. */
export function Sidebar({ tables, schema, onSchema, current, onOpen, history, onHistory }: Props) {
  const [search, setSearch] = useState('')
  const [pane, setPane] = useState<'items' | 'history'>('items')
  const schemas = useMemo(() => [...new Set((tables ?? []).map((t) => t.schema))], [tables])
  const needle = search.trim().toLowerCase()
  const shown = (tables ?? []).filter(
    (t) => t.schema === schema && (!needle || t.name.toLowerCase().includes(needle)),
  )

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-head">
        {schemas.length > 1 && (
          <select
            className="select"
            aria-label="Schema"
            value={schema}
            onChange={(e) => onSchema(e.target.value)}
          >
            {schemas.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        <input
          className="input"
          type="search"
          aria-label="Search for item"
          placeholder="Search for item…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {pane === 'items' ? (
        <ul className="tree" aria-label="Items">
          {tables === null && <li className="tree-empty">Loading…</li>}
          {tables !== null && !shown.length && (
            <li className="tree-empty">{needle ? 'Nothing matches.' : 'No tables here.'}</li>
          )}
          {GROUPS.map((group) => {
            const items = shown.filter((t) => group.kinds.includes(t.kind))
            if (!items.length) return null
            return (
              <li key={group.title}>
                <div className="tree-group">{group.title}</div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={group.title}>
                  {items.map((t) => (
                    <li key={t.name}>
                      <button
                        type="button"
                        className="tree-item"
                        aria-current={current?.schema === t.schema && current.table === t.name}
                        onClick={() => onOpen(t)}
                        title={`${t.schema}.${t.name}`}
                      >
                        <Icon name={kindIcon(t.kind)} size={14} />
                        <span className="name">{t.name}</span>
                        {t.estimatedRows !== null && (
                          <span className="count">{compact(t.estimatedRows)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="tree" aria-label="History">
          {!history.length && <li className="tree-empty">Statements you run show here.</li>}
          {history
            .filter((h) => !needle || h.sql.toLowerCase().includes(needle))
            .map((h) => (
              <li key={h.at + h.sql}>
                <button
                  type="button"
                  className="tree-item"
                  title={h.sql}
                  onClick={() => onHistory(h.sql)}
                >
                  <Icon name="sql" size={14} />
                  <span className="name">{h.sql.replace(/\s+/g, ' ')}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      <div className="sidebar-foot">
        <div className="segmented" role="group" aria-label="Sidebar view">
          <button type="button" aria-pressed={pane === 'items'} onClick={() => setPane('items')}>
            Items
          </button>
          <button
            type="button"
            aria-pressed={pane === 'history'}
            onClick={() => setPane('history')}
          >
            History
          </button>
        </div>
      </div>
    </aside>
  )
}

/** 1.2k, 3.4M: room for a row count beside a name. */
function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
