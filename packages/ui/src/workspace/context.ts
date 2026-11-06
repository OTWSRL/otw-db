import { createContext, useContext } from 'react'
import type { Api, Connection } from '../api.ts'
import type { GridColumn } from './DataGrid.tsx'

/** A line of the console: every statement the workspace ran, as TablePlus logs them. */
export interface LogEntry {
  at: Date
  statement: string
  durationMs?: number
  error?: string
}

/** The row the right-hand panel shows, from whichever grid has the selection. */
export interface ShownRow {
  columns: readonly GridColumn[]
  values: readonly (string | null)[]
}

export interface Workspace {
  api: Api
  connection: Connection
  log(entry: Omit<LogEntry, 'at'>): void
  showRow(row: ShownRow | null): void
  /** Bumped by ⌘R: tabs reload what they show. */
  refreshKey: number
  /** Bumped by ⌘F: the active table tab opens its filter bar. */
  filterKey: number
}

export const WorkspaceContext = createContext<Workspace | null>(null)

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error('useWorkspace() is for components inside a workspace.')
  return workspace
}
