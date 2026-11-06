import { useEffect, useRef, useState } from 'react'
import type { TableSummary } from '../api.ts'
import { Icon, kindIcon } from '../ui/icons.tsx'

/** Every letter of `needle`, in order, somewhere in `name`: "usr" finds "users". */
export function fuzzy(name: string, needle: string): boolean {
  let at = 0
  for (const letter of needle.toLowerCase()) {
    at = name.toLowerCase().indexOf(letter, at)
    if (at === -1) return false
    at++
  }
  return true
}

/** ⌘P: open any table by typing a few letters of its name. */
export function QuickOpen({
  tables,
  onOpen,
  onClose,
}: {
  tables: readonly TableSummary[]
  onOpen(table: TableSummary): void
  onClose(): void
}) {
  const [needle, setNeedle] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const matches = tables
    .filter((t) => fuzzy(t.name, needle.trim()))
    // Names that start with what was typed first, then the rest as they come.
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(needle.toLowerCase())) -
        Number(!b.name.toLowerCase().startsWith(needle.toLowerCase())),
    )
    .slice(0, 50)
  const choice = matches[Math.min(index, matches.length - 1)]

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Open anything">
        <input
          ref={input}
          className="input"
          aria-label="Table name"
          placeholder="Open table…"
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
            } else if (e.key === 'Enter' && choice) onOpen(choice)
          }}
        />
        <ul role="listbox" aria-label="Tables">
          {matches.map((t) => (
            <li key={`${t.schema}.${t.name}`}>
              <button
                type="button"
                role="option"
                aria-selected={t === choice}
                onMouseEnter={() => setIndex(matches.indexOf(t))}
                onClick={() => onOpen(t)}
              >
                <Icon name={kindIcon(t.kind)} size={14} />
                {t.name}
                <span className="schema">{t.schema}</span>
              </button>
            </li>
          ))}
          {!matches.length && <li className="tree-empty">No table matches.</li>}
        </ul>
      </div>
    </div>
  )
}
