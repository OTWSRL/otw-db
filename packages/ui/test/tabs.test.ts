import { describe, expect, it } from 'vitest'
import {
  EMPTY_TABS,
  loadTabs,
  saveTabs,
  tabsReducer,
  type TabsAction,
  type TabsState,
} from '../src/tabs.ts'

const run = (...actions: TabsAction[]) => actions.reduce(tabsReducer, EMPTY_TABS)

describe('tabsReducer', () => {
  it('opens a table once, showing its tab when opened again', () => {
    const state = run(
      { type: 'open-table', schema: 'public', table: 'posts' },
      { type: 'open-table', schema: 'public', table: 'users' },
      { type: 'open-table', schema: 'public', table: 'posts' },
    )
    expect(state.tabs.map((t) => t.id)).toEqual(['table:public.posts', 'table:public.users'])
    expect(state.active).toBe('table:public.posts')
  })

  it('numbers new SQL editors, and keeps counting after one closes', () => {
    const state = run(
      { type: 'new-query' },
      { type: 'new-query', sql: 'SELECT 1' },
      { type: 'close', id: 'query:2' },
      { type: 'new-query' },
    )
    expect(state.tabs).toEqual([
      { id: 'query:1', kind: 'query', title: 'Query 1', sql: '' },
      { id: 'query:3', kind: 'query', title: 'Query 3', sql: '' },
    ])
  })

  it('shows the right-hand neighbour when the active tab closes, or else the left', () => {
    const three = run(
      { type: 'new-query' },
      { type: 'new-query' },
      { type: 'new-query' },
      { type: 'activate', id: 'query:2' },
    )
    expect(tabsReducer(three, { type: 'close', id: 'query:2' }).active).toBe('query:3')
    const last = tabsReducer(three, { type: 'activate', id: 'query:3' })
    expect(tabsReducer(last, { type: 'close', id: 'query:3' }).active).toBe('query:2')
    expect(
      tabsReducer(run({ type: 'new-query' }), { type: 'close', id: 'query:1' }).active,
    ).toBeNull()
  })

  it('keeps the active tab when another closes', () => {
    const state = run({ type: 'new-query' }, { type: 'new-query' })
    expect(tabsReducer(state, { type: 'close', id: 'query:1' }).active).toBe('query:2')
  })

  it('cycles through tabs both ways, wrapping around', () => {
    const state = run({ type: 'new-query' }, { type: 'new-query' }, { type: 'new-query' })
    expect(tabsReducer(state, { type: 'cycle', by: 1 }).active).toBe('query:1')
    expect(tabsReducer(state, { type: 'cycle', by: -1 }).active).toBe('query:2')
    expect(tabsReducer(EMPTY_TABS, { type: 'cycle', by: 1 })).toBe(EMPTY_TABS)
  })

  it('edits only the SQL editor named', () => {
    const state = run(
      { type: 'new-query' },
      { type: 'open-table', schema: 's', table: 't' },
      { type: 'edit-sql', id: 'query:1', sql: 'SELECT 2' },
    )
    expect(state.tabs[0]).toMatchObject({ sql: 'SELECT 2' })
    expect(
      tabsReducer(state, { type: 'edit-sql', id: 'table:s.t', sql: 'x' }).tabs[1],
    ).not.toHaveProperty('sql')
  })
})

describe('saved tabs', () => {
  function memory(): Storage {
    const items = new Map<string, string>()
    return {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      getItem: (k) => items.get(k) ?? null,
      key: (i) => [...items.keys()][i] ?? null,
      removeItem: (k) => void items.delete(k),
      setItem: (k, v) => void items.set(k, v),
    }
  }

  it('keeps each connection’s tabs apart', () => {
    const storage = memory()
    const state: TabsState = run({ type: 'new-query', sql: 'SELECT 1' })
    saveTabs('main', state, storage)
    expect(loadTabs('main', storage)).toEqual(state)
    expect(loadTabs('other', storage)).toBe(EMPTY_TABS)
  })

  it('starts empty when what’s saved is broken, or storage throws', () => {
    const storage = memory()
    storage.setItem('otw-db:tabs:main', '{nope')
    expect(loadTabs('main', storage)).toBe(EMPTY_TABS)
    const throwing = {
      ...memory(),
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(loadTabs('main', throwing)).toBe(EMPTY_TABS)
    expect(() => saveTabs('main', EMPTY_TABS, throwing)).not.toThrow()
  })
})
