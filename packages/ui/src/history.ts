import { safeStorage } from './tabs.ts'

/** A statement run from a SQL editor, newest first in the sidebar's History. */
export interface HistoryEntry {
  sql: string
  at: string
}

const MAX = 200
const key = (connection: string) => `otw-db:history:${connection}`

export function loadHistory(connection: string, storage = safeStorage()): HistoryEntry[] {
  try {
    const saved = JSON.parse(storage?.getItem(key(connection)) ?? '[]') as unknown
    return Array.isArray(saved) ? (saved as HistoryEntry[]) : []
  } catch {
    // Blocked storage or someone else's data: no history.
    return []
  }
}

/** Adds a statement to the top, moving it there if it was run before; keeps the newest 200. */
export function remember(connection: string, sql: string, storage = safeStorage()): HistoryEntry[] {
  const entry = { sql, at: new Date().toISOString() }
  const history = [entry, ...loadHistory(connection, storage).filter((e) => e.sql !== sql)].slice(
    0,
    MAX,
  )
  try {
    storage?.setItem(key(connection), JSON.stringify(history))
  } catch {
    // Full or blocked: this session still shows it.
  }
  return history
}
