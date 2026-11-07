import { describe, expect, it } from 'vitest'
import { addressOf, readAddress, storageScope } from '../src/address.ts'

describe('the address', () => {
  it.each([
    ['', { connection: '', database: null }],
    ['#', { connection: '', database: null }],
    ['#main', { connection: 'main', database: null }],
    ['#main/', { connection: 'main', database: null }],
    ['#main/arena_live', { connection: 'main', database: 'arena_live' }],
    ['#main/odd%20name%2Fx%2541', { connection: 'main', database: 'odd name/x%41' }],
    ['#main/odd name/x', { connection: 'main', database: 'odd name/x' }],
    ['#main/%E0%A4%A', { connection: 'main', database: null }],
  ])('reads %s', (hash, open) => {
    expect(readAddress(hash)).toEqual(open)
  })

  it.each([
    [{ connection: '', database: null }, ''],
    [{ connection: 'main', database: null }, 'main'],
    [{ connection: 'main', database: 'odd name/x%41' }, 'main/odd%20name%2Fx%2541'],
  ])('writes %o as #%s, which reads back the same', (open, hash) => {
    expect(addressOf(open)).toBe(hash)
    expect(readAddress(`#${hash}`)).toEqual(open)
  })
})

describe('storageScope', () => {
  it('keeps a connection’s own database under its name, as before there were others', () => {
    expect(storageScope('main', null)).toBe('main')
  })

  it('keeps each other database apart', () => {
    expect(storageScope('main', 'archive')).toBe('main/archive')
  })
})
