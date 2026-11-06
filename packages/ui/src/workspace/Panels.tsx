import { useEffect, useRef } from 'react'
import type { Tab } from '../tabs.ts'
import { Icon, kindIcon } from '../ui/icons.tsx'
import type { LogEntry, ShownRow } from './context.ts'

/** The tabs across the top: tables and SQL editors, like a browser's. */
export function TabBar({
  tabs,
  active,
  onActivate,
  onClose,
  kinds,
}: {
  tabs: readonly Tab[]
  active: string | null
  onActivate(id: string): void
  onClose(id: string): void
  /** Each table tab's kind, for its icon. */
  kinds: ReadonlyMap<string, string>
}) {
  if (!tabs.length) return null
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      {tabs.map((tab) => {
        const title = tab.kind === 'table' ? tab.table : tab.title
        return (
          <div
            key={tab.id}
            className="tab"
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === active}
            title={tab.kind === 'table' ? `${tab.schema}.${tab.table}` : tab.title}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
            onKeyDown={(e) => e.key === 'Enter' && onActivate(tab.id)}
          >
            <Icon
              name={
                tab.kind === 'query'
                  ? 'sql'
                  : kindIcon(kinds.get(`${tab.schema}.${tab.table}`) ?? 'table')
              }
              size={13}
            />
            <span className="title">{title}</span>
            <button
              type="button"
              className="icon-button close"
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** The right sidebar: the selected row's fields, one per line, whole. */
export function RowPanel({ row }: { row: ShownRow | null }) {
  return (
    <aside className="panel" aria-label="Row">
      <div className="panel-head">Row</div>
      {row ? (
        <dl className="fields">
          {row.columns.map((column, i) => (
            <div key={`${column.name}-${i}`}>
              <dt>
                {column.name} <span className="type">{column.type}</span>
              </dt>
              <dd>{row.values[i] ?? <span className="null">NULL</span>}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="tree-empty">Select a row to see its fields.</div>
      )}
    </aside>
  )
}

/** The console: every statement run, newest last, with how long it took or how it failed. */
export function ConsolePanel({ entries }: { entries: readonly LogEntry[] }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [entries])
  return (
    <div className="console" role="log" aria-label="Console">
      {entries.map((entry, i) => (
        <div key={i} className={`console-entry${entry.error ? ' failed' : ''}`}>
          <span className="time">{entry.at.toLocaleTimeString()}</span>
          <span className="sql">
            {entry.statement}
            {entry.error && ` — ${entry.error}`}
          </span>
          <span className="took">
            {entry.durationMs !== undefined ? `${entry.durationMs} ms` : ''}
          </span>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

/** A toolbar button with its shortcut in the tooltip. */
export function ToolButton({
  icon,
  label,
  shortcut,
  pressed,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  label: string
  shortcut?: string
  pressed?: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}
