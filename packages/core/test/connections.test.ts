import { describe, expect, it } from 'vitest'
import { connectionsFromEnv, driverKind } from '../src/index.ts'

describe('connectionsFromEnv', () => {
  it('reads DB_ADMIN_<NAME>_URL and its settings, sorted by name', () => {
    expect(
      connectionsFromEnv({
        DB_ADMIN_SHOP_DATA_URL: 'postgres://shop@db/shop',
        DB_ADMIN_SHOP_DATA_ACCESS: 'write',
        DB_ADMIN_SHOP_DATA_LABEL: 'Shop',
        DB_ADMIN_SHOP_DATA_TAG: 'production',
        DB_ADMIN_SHOP_DATA_DATABASES: 'one',
        DB_ADMIN_ANALYTICS_URL: ' mysql://a@db/analytics ',
        PATH: '/usr/bin',
      }),
    ).toEqual([
      { name: 'analytics', url: 'mysql://a@db/analytics', access: 'read' },
      {
        name: 'shop-data',
        url: 'postgres://shop@db/shop',
        access: 'write',
        label: 'Shop',
        tag: 'production',
        databases: 'one',
      },
    ])
  })

  it('skips an empty URL', () => {
    expect(connectionsFromEnv({ DB_ADMIN_MAIN_URL: '  ' })).toEqual([])
  })

  it.each([
    [
      { DB_ADMIN_MAIN_URL: 'postgres://x', DB_ADMIN_MAIN_ACCESS: 'admin' },
      'DB_ADMIN_MAIN_ACCESS must be "read" or "write", not "admin".',
    ],
    [
      { DB_ADMIN_MAIN_URL: 'postgres://x', DB_ADMIN_MAIN_TAG: 'prod' },
      'DB_ADMIN_MAIN_TAG must be one of local, development, testing, staging, production, not "prod".',
    ],
    [
      { DB_ADMIN_MAIN_URL: 'postgres://x', DB_ADMIN_MAIN_DATABASES: 'some' },
      'DB_ADMIN_MAIN_DATABASES must be "all" or "one", not "some".',
    ],
    [{ DB_ADMIN_MAIN_URL: 'redis://x' }, 'DB_ADMIN_MAIN_URL must start with postgres://'],
  ])('refuses %o', (env, message) => {
    expect(() => connectionsFromEnv(env)).toThrow(message)
  })
})

describe('driverKind', () => {
  it.each([
    ['postgres://x', 'postgres'],
    ['POSTGRESQL://x', 'postgres'],
    ['mysql://x', 'mysql'],
    ['mariadb://x', 'mysql'],
    ['sqlite:./data.db', 'sqlite'],
    ['file:/var/data.db', 'sqlite'],
  ])('%s is %s', (url, kind) => {
    expect(driverKind(url)).toBe(kind)
  })

  it('names only the scheme of an address it refuses, never the rest, which may hold a password', () => {
    expect(() => driverKind('//admin:s3cret@db/x')).toThrow('not an address without a scheme.')
    expect(() => driverKind('//admin:s3cret@db/x')).not.toThrow('s3cret')
    expect(() => driverKind('mongodb://admin:s3cret@db')).toThrow('not "mongodb:".')
  })
})
