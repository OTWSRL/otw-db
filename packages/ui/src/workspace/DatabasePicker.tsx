import { useEffect, useRef, useState } from 'react'
import type { Api, ApiError, DatabaseList } from '../api.ts'
import { Icon } from '../ui/icons.tsx'
import { matching } from './QuickOpen.tsx'

/**
 * ⌘K: another of the server's databases, opened by typing a few letters of its name, as
 * TablePlus's Open database. The list is asked for when it opens, never before.
 */
export function DatabasePicker({
  api,
  connection,
  open,
  onOpen,
  onClose,
}: {
  api: Api
  connection: string
  /** The database the workspace shows, marked in the list. */
  open: string | null
  /** The database chosen; null for the connection's own. */
  onOpen(database: string | null): void
  onClose(): void
}) {
  const [list, setList] = useState<DatabaseList | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [needle, setNeedle] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    let current = true
    api.databases(connection).then(
      (databases) => {
        if (current) setList(databases)
      },
      (e: unknown) => {
        if (current) setError(e as ApiError)
      },
    )
    return () => {
      current = false
    }
  }, [api, connection])

  const matches = matching(list?.databases ?? [], (name) => name, needle)
  const choice = matches[Math.min(index, matches.length - 1)]
  const choose = (name: string) => onOpen(name === list?.current ? null : name)

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Open database">
        <input
          ref={input}
          className="input"
          aria-label="Database name"
          placeholder="Open database…"
          value={needle}
          onChange={(e) => {
            setNeedle(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && choice !== undefined) choose(choice)
          }}
        />
        <ul role="listbox" aria-label="Databases">
          {matches.map((name) => (
            <li key={name}>
              <button
                type="button"
                role="option"
                aria-selected={name === choice}
                aria-current={name === open || undefined}
                onMouseEnter={() => setIndex(matches.indexOf(name))}
                onClick={() => choose(name)}
              >
                <Icon name="database" size={14} />
                {name}
                {name === open && <span className="schema">open</span>}
              </button>
            </li>
          ))}
          {error && (
            <li className="tree-empty" role="alert">
              {error.message}
            </li>
          )}
          {!list && !error && <li className="tree-empty">Loading…</li>}
          {list && !matches.length && <li className="tree-empty">No database matches.</li>}
        </ul>
      </div>
    </div>
  )
}
