import { describe, expect, it } from 'vitest'
import { appConnections } from '../src/connections.ts'
import { listedAs, listedUsers } from '../src/users.ts'

describe('appConnections', () => {
  it('takes the connections the app names, and then leaves its own database out', () => {
    expect(
      appConnections({
        DB_ADMIN_SHOP_URL: 'postgres://u:p@h/shop',
        DB_ADMIN_SHOP_ACCESS: 'write',
        DATABASE_URL: 'postgres://u:p@h/app',
      }),
    ).toEqual([{ name: 'shop', url: 'postgres://u:p@h/shop', access: 'write' }])
  })

  it('opens the app’s own database, read-only, when it names none', () => {
    expect(appConnections({ DATABASE_URL: ' postgres://u:p@h/app ' })).toEqual([
      { name: 'app', label: 'This app', url: 'postgres://u:p@h/app', access: 'read' },
    ])
    expect(
      appConnections({ POSTGRES_URL: 'postgres://u:p@h/app', DB_ADMIN_APP_ACCESS: 'write' }),
    ).toMatchObject([{ access: 'write' }])
  })

  it('prefers the address that doesn’t go through a transaction pooler', () => {
    expect(
      appConnections({
        POSTGRES_URL: 'postgres://u:p@pooler:6543/postgres',
        POSTGRES_URL_NON_POOLING: 'postgres://u:p@pooler:5432/postgres',
        DATABASE_URL: 'postgres://u:p@h-pooler/neon',
        DATABASE_URL_UNPOOLED: 'postgres://u:p@h/neon',
      })[0]!.url,
    ).toBe('postgres://u:p@h/neon')
    expect(
      appConnections({
        POSTGRES_URL: 'postgres://u:p@pooler:6543/postgres',
        POSTGRES_URL_NON_POOLING: 'postgres://u:p@pooler:5432/postgres',
      })[0]!.url,
    ).toBe('postgres://u:p@pooler:5432/postgres')
  })

  it('passes over an address it can’t open, rather than stop the app', () => {
    expect(
      appConnections({
        DATABASE_URL: 'prisma://accelerate.prisma-data.net/?api_key=x',
        POSTGRES_URL: 'postgres://u:p@h/app',
      })[0]!.url,
    ).toBe('postgres://u:p@h/app')
    expect(appConnections({ DATABASE_URL: 'mongodb+srv://u:p@cluster/app' })).toEqual([])
    expect(appConnections({})).toEqual([])
  })
})

describe('the users list', () => {
  it('is emails or ids separated by commas, whatever their case and spacing', () => {
    const listed = listedUsers(' Tahir@OTW.design, ana@example.com ,, 5b1f-id ')
    expect([...listed]).toEqual(['tahir@otw.design', 'ana@example.com', '5b1f-id'])
    expect(listedUsers(undefined).size).toBe(0)
    expect(listedUsers(' , ').size).toBe(0)
  })

  it('finds a signed-in user by any name they have, and nobody by none', () => {
    const listed = listedUsers('tahir@otw.design,5b1f-id')
    expect(listedAs(listed, ['TAHIR@otw.design '])).toBe('tahir@otw.design')
    expect(listedAs(listed, [undefined, '5B1F-ID'])).toBe('5b1f-id')
    expect(listedAs(listed, ['mallory@example.com', null, ''])).toBeUndefined()
    expect(listedAs(listedUsers(''), ['tahir@otw.design'])).toBeUndefined()
  })
})
