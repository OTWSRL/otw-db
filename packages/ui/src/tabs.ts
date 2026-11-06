/** A tab of the workspace: a table, or a SQL editor. */
export type Tab =
  | { id: string; kind: 'table'; schema: string; table: string }
  | { id: string; kind: 'query'; title: string; sql: string }

export interface TabsState {
  tabs: Tab[]
  active: string | null
  /** Numbers the next "Query n". */
  queries: number
}

export type TabsAction =
  | { type: 'open-table'; schema: string; table: string }
  | { type: 'new-query'; sql?: string }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'cycle'; by: 1 | -1 }
  | { type: 'edit-sql'; id: string; sql: string }

export const EMPTY_TABS: TabsState = { tabs: [], active: null, queries: 0 }

const tableId = (schema: string, table: string) => `table:${schema}.${table}`

/**
 * The workspace's tabs. Opening a table that has a tab shows that tab; closing the active tab
 * shows its right-hand neighbour, or else the left, as browsers do.
 */
export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open-table': {
      const id = tableId(action.schema, action.table)
      if (state.tabs.some((t) => t.id === id)) return { ...state, active: id }
      const tab: Tab = { id, kind: 'table', schema: action.schema, table: action.table }
      return { ...state, tabs: [...state.tabs, tab], active: id }
    }
    case 'new-query': {
      const number = state.queries + 1
      const id = `query:${number}`
      const tab: Tab = { id, kind: 'query', title: `Query ${number}`, sql: action.sql ?? '' }
      return { tabs: [...state.tabs, tab], active: id, queries: number }
    }
    case 'close': {
      const index = state.tabs.findIndex((t) => t.id === action.id)
      if (index === -1) return state
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      const active =
        state.active === action.id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.active
      return { ...state, tabs, active }
    }
    case 'activate':
      return state.tabs.some((t) => t.id === action.id) ? { ...state, active: action.id } : state
    case 'cycle': {
      if (!state.tabs.length) return state
      const index = state.tabs.findIndex((t) => t.id === state.active)
      const next = (index + action.by + state.tabs.length) % state.tabs.length
      return { ...state, active: state.tabs[next]!.id }
    }
    case 'edit-sql':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id && t.kind === 'query' ? { ...t, sql: action.sql } : t,
        ),
      }
  }
}

/** The tabs as saved for a connection, or none when nothing (valid) is saved. */
export function loadTabs(
  connection: string,
  storage: Storage | undefined = safeStorage(),
): TabsState {
  try {
    const saved = storage?.getItem(`otw-db:tabs:${connection}`)
    if (!saved) return EMPTY_TABS
    const state = JSON.parse(saved) as TabsState
    if (!Array.isArray(state.tabs) || typeof state.queries !== 'number') return EMPTY_TABS
    return state
  } catch {
    // Storage blocked, or what's there isn't ours: start with no tabs.
    return EMPTY_TABS
  }
}

export function saveTabs(
  connection: string,
  state: TabsState,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(`otw-db:tabs:${connection}`, JSON.stringify(state))
  } catch {
    // Full or blocked: the tabs just aren't remembered.
  }
}

/** localStorage, or undefined where reading it throws (blocked cookies, some private modes). */
export function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
