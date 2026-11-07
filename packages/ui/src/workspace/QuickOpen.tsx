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

/** The items whose name has `needle`'s letters, those that start with it first; 50 at most. */
export function matching<T>(items: readonly T[], name: (item: T) => string, needle: string): T[] {
  const typed = needle.trim().toLowerCase()
  return items
    .filter((item) => fuzzy(name(item), typed))
    .sort(
      (a, b) =>
        Number(!name(a).toLowerCase().startsWith(typed)) -
        Number(!name(b).toLowerCase().startsWith(typed)),
    )
    .slice(0, 50)
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
  const matches = matching(tables, (t) => t.name, needle)
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
