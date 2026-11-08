import { describe, expect, it } from 'vitest'
import {
  backupFileName,
  headerLine,
  readHeader,
  readTrailer,
  trailerLine,
  type BackupHeader,
} from '../src/backup/format.ts'
import { dumpArgs, libpqTarget, schemaPattern } from '../src/backup/pg-tools.ts'

const HEADER: BackupHeader = {
  format: 'otw-db',
  version: 1,
  createdAt: '2026-11-08T12:00:00.000Z',
  database: 'shop',
  server: 'PostgreSQL 17.5',
  serverVersion: 170005,
  schemas: ['public', 'odd "one"'],
  roles: ['app'],
  notIncluded: ['aggregate public.median(numeric)'],
}

describe('a backup’s first and last lines', () => {
  it('reads back the header it writes, on one line', () => {
    const line = headerLine(HEADER)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(readHeader(line.slice(0, -1))).toEqual(HEADER)
  })

  it('refuses a line that isn’t an otw-db header, or one with no schemas or odd ones', () => {
    const notOne = /This file isn't an otw-db backup/
    expect(() => readHeader('-- PostgreSQL database dump')).toThrow(notOne)
    expect(() => readHeader('-- otw-db backup {not json')).toThrow(notOne)
    expect(() => readHeader(headerLine({ ...HEADER, schemas: [] }))).toThrow(notOne)
    expect(() =>
      readHeader(headerLine({ ...HEADER, schemas: [1] as unknown as string[] })),
    ).toThrow(notOne)
  })

  it('refuses a newer format, saying to update', () => {
    expect(() => readHeader(headerLine({ ...HEADER, version: 2 }))).toThrow(
      'This backup was made by a newer otw-db (format 2): update otw-db to restore it.',
    )
  })

  it('takes an older header without roles or what it left out', () => {
    const older: Partial<BackupHeader> = { ...HEADER }
    delete older.roles
    delete older.notIncluded
    expect(readHeader(headerLine(older as BackupHeader))).toMatchObject({
      roles: [],
      notIncluded: [],
    })
  })

  it('tells a whole file’s last line from anything else', () => {
    expect(readTrailer(trailerLine({ tables: 3, rows: 42 }).trimEnd())).toEqual({
      tables: 3,
      rows: 42,
    })
    expect(readTrailer('INSERT INTO t VALUES (1);')).toBeNull()
    expect(readTrailer('-- otw-db backup complete {"tables":3')).toBeNull()
  })

  it('names a file for the connection, the database and the minute, safely', () => {
    expect(backupFileName('main', 'shop', new Date('2026-11-08T14:30:59Z'), 'sql.gz')).toBe(
      'main-shop-2026-11-08-1430.sql.gz',
    )
    expect(backupFileName('main', 'a/b "c"', new Date('2026-11-08T14:30:00Z'), 'dump')).toBe(
      'main-a_b_c_-2026-11-08-1430.dump',
    )
  })
})

describe('pg_dump’s and pg_restore’s target', () => {
  it('takes the password out of the URL, into the environment', () => {
    expect(libpqTarget('postgres://ana:s%40cret@db.example.com:5432/shop')).toEqual({
      url: 'postgres://ana@db.example.com:5432/shop',
      env: { PGPASSWORD: 's@cret' },
    })
  })

  it('drops what only node-postgres knows, as libpq would refuse it', () => {
    expect(
      libpqTarget('postgres://ana@h/db?uselibpqcompat=true&sslmode=require&application_name=a%20b')
        .url,
    ).toBe('postgres://ana@h/db?sslmode=require&application_name=a%20b')
    expect(libpqTarget('postgres://ana@h/db?ssl=true').url).toBe(
      'postgres://ana@h/db?sslmode=require',
    )
    expect(libpqTarget('postgres://ana@h/db?ssl=false').url).toBe('postgres://ana@h/db')
    expect(libpqTarget('postgres://ana@h/db?sslmode=no-verify').url).toBe(
      'postgres://ana@h/db?sslmode=require',
    )
  })

  it('uses Supabase’s pooler in session mode, as a dump runs in one session', () => {
    expect(libpqTarget('postgres://p.ref:pw@aws-0-eu.pooler.supabase.com:6543/postgres').url).toBe(
      'postgres://p.ref@aws-0-eu.pooler.supabase.com:5432/postgres',
    )
  })

  it('keeps a socket address without a host', () => {
    expect(libpqTarget('postgres://ana@/shop?host=/var/run/postgresql').url).toBe(
      'postgres://ana@/shop?host=/var/run/postgresql',
    )
  })

  it('names each schema exactly, never as a pattern, and leaves the restores’ own out', () => {
    expect(schemaPattern('we*ird "one"')).toBe('"we*ird ""one"""')
    expect(dumpArgs('postgres://h/db', ['public', '-x'])).toEqual([
      '--format=custom',
      '--no-password',
      '--schema="public"',
      '--schema="-x"',
      '--exclude-schema="otw_db_restore"',
      '--dbname=postgres://h/db',
    ])
  })
})
