import { describe, expect, it } from 'vitest'
import {
  NOTHING_STAGED,
  rowId,
  stagedCount,
  stagedReducer,
  toChanges,
  type StagedAction,
} from '../src/edits.ts'

const run = (...actions: StagedAction[]) => actions.reduce(stagedReducer, NOTHING_STAGED)
const one = { id: '["1"]', key: { id: '1' } }

describe('rowId', () => {
  it('names a row by its primary key’s values, in the key’s order', () => {
    expect(rowId(['b', 'a'], ['a', 'b', 'c'], ['1', '2', 'x'])).toEqual({
      id: '["2","1"]',
      key: { b: '2', a: '1' },
    })
  })

  it('can’t name a row without a primary key, or with a NULL in it', () => {
    expect(rowId([], ['a'], ['1'])).toBeNull()
    expect(rowId(['a'], ['a'], [null])).toBeNull()
    expect(rowId(['missing'], ['a'], ['1'])).toBeNull()
  })
})

describe('stagedReducer', () => {
  it('keeps a row’s edits together, and forgets an edit typed back to the original', () => {
    const state = run(
      { type: 'edit', ...one, column: 'title', value: 'New', original: 'Old' },
      { type: 'edit', ...one, column: 'body', value: null, original: 'text' },
    )
    expect(state.updates[one.id]).toEqual({ key: one.key, values: { title: 'New', body: null } })
    const back = stagedReducer(state, {
      type: 'edit',
      ...one,
      column: 'title',
      value: 'Old',
      original: 'Old',
    })
    expect(back.updates[one.id]!.values).toEqual({ body: null })
    const none = stagedReducer(back, {
      type: 'edit',
      ...one,
      column: 'body',
      value: 'text',
      original: 'text',
    })
    expect(none.updates).toEqual({})
    expect(stagedCount(none)).toBe(0)
  })

  it('adds new rows, fills them in, and removes them', () => {
    const state = run(
      { type: 'add' },
      { type: 'add' },
      { type: 'edit-new', id: 2, column: 'title', value: 'Hi' },
      { type: 'remove-new', id: 1 },
    )
    expect(state.inserts).toEqual([{ id: 2, values: { title: 'Hi' } }])
    expect(state.next).toBe(3)
  })

  it('deletes and undeletes rows', () => {
    const state = run({ type: 'delete', ...one })
    expect(state.deletes).toEqual({ [one.id]: one.key })
    expect(stagedReducer(state, { type: 'undelete', id: one.id }).deletes).toEqual({})
  })
})

describe('toChanges', () => {
  it('deletes first, then updates of rows that stay, then inserts; and counts them so', () => {
    const two = { id: '["2"]', key: { id: '2' } }
    const state = run(
      { type: 'add' },
      { type: 'edit-new', id: 1, column: 'title', value: 'New' },
      { type: 'edit', ...one, column: 'title', value: 'Changed', original: 'Old' },
      { type: 'edit', ...two, column: 'title', value: 'Gone anyway', original: 'Old' },
      { type: 'delete', ...two },
    )
    expect(toChanges(state)).toEqual([
      { type: 'delete', key: { id: '2' } },
      { type: 'update', key: { id: '1' }, values: { title: 'Changed' } },
      { type: 'insert', values: { title: 'New' } },
    ])
    expect(stagedCount(state)).toBe(3)
  })
})
