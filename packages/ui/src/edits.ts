import type { Change } from '@otwdesign/db-core'

type Values = Readonly<Record<string, string | null>>
type Key = Readonly<Record<string, string>>

/**
 * The edits a table tab holds until ⌘S. Existing rows are named by their primary key, not their
 * place on the page, so edits stay with their rows across pages, sorting and refreshes.
 */
export interface Staged {
  /** By row id (see `rowId`): the row's key and its new values. */
  updates: Readonly<Record<string, { key: Key; values: Values }>>
  /** By row id: the key of each row to delete. */
  deletes: Readonly<Record<string, Key>>
  /** New rows, in the order added; a column left out takes its default. */
  inserts: readonly { id: number; values: Values }[]
  /** Numbers the next new row. */
  next: number
}

export const NOTHING_STAGED: Staged = { updates: {}, deletes: {}, inserts: [], next: 1 }

export type StagedAction =
  | {
      type: 'edit'
      id: string
      key: Key
      column: string
      value: string | null
      original: string | null
    }
  | { type: 'edit-new'; id: number; column: string; value: string | null }
  | { type: 'add' }
  | { type: 'delete'; id: string; key: Key }
  | { type: 'undelete'; id: string }
  | { type: 'remove-new'; id: number }

/**
 * A row's id and key from its primary key's values, or null when it can't be named (no primary
 * key, or a NULL in it), and so can't be edited.
 */
export function rowId(
  primaryKey: readonly string[],
  columns: readonly string[],
  values: readonly (string | null)[],
): { id: string; key: Key } | null {
  if (!primaryKey.length) return null
  const key: Record<string, string> = {}
  for (const column of primaryKey) {
    const value = values[columns.indexOf(column)]
    if (value === undefined || value === null) return null
    key[column] = value
  }
  return { id: JSON.stringify(primaryKey.map((c) => key[c])), key }
}

export function stagedReducer(state: Staged, action: StagedAction): Staged {
  switch (action.type) {
    case 'edit': {
      const current = state.updates[action.id]
      const values: Record<string, string | null> = { ...current?.values }
      // Typed back to what it was: not a change any more.
      if (action.value === action.original) delete values[action.column]
      else values[action.column] = action.value
      const updates = { ...state.updates }
      if (Object.keys(values).length) updates[action.id] = { key: action.key, values }
      else delete updates[action.id]
      return { ...state, updates }
    }
    case 'edit-new':
      return {
        ...state,
        inserts: state.inserts.map((row) =>
          row.id === action.id
            ? { ...row, values: { ...row.values, [action.column]: action.value } }
            : row,
        ),
      }
    case 'add':
      return {
        ...state,
        inserts: [...state.inserts, { id: state.next, values: {} }],
        next: state.next + 1,
      }
    case 'delete':
      return { ...state, deletes: { ...state.deletes, [action.id]: action.key } }
    case 'undelete': {
      const deletes = { ...state.deletes }
      delete deletes[action.id]
      return { ...state, deletes }
    }
    case 'remove-new':
      return { ...state, inserts: state.inserts.filter((row) => row.id !== action.id) }
  }
}

/** How many changes ⌘S would make. */
export function stagedCount(state: Staged): number {
  const updates = Object.keys(state.updates).filter((id) => !(id in state.deletes)).length
  return updates + Object.keys(state.deletes).length + state.inserts.length
}

/**
 * The changes for the API: deletes first (so a new row may reuse a deleted one's unique value),
 * then updates of rows that stay, then inserts.
 */
export function toChanges(state: Staged): Change[] {
  const deletes = Object.values(state.deletes).map((key): Change => ({ type: 'delete', key }))
  const updates = Object.entries(state.updates)
    .filter(([id]) => !(id in state.deletes))
    .map(([, { key, values }]): Change => ({ type: 'update', key, values }))
  const inserts = state.inserts.map(({ values }): Change => ({ type: 'insert', values }))
  return [...deletes, ...updates, ...inserts]
}
