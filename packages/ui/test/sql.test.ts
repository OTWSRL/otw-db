import { describe, expect, it } from 'vitest'
import { looksLikeWrite, splitStatements, statementAt } from '../src/sql.ts'

const texts = (sql: string) => splitStatements(sql).map((s) => s.text)

describe('splitStatements', () => {
  it('splits at semicolons and trims, leaving out empty statements', () => {
    expect(texts('SELECT 1;  SELECT 2 ;;\n\nSELECT 3')).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
    ])
  })

  it('knows where each statement is in the text', () => {
    const sql = 'SELECT 1;\n  SELECT 2;'
    for (const s of splitStatements(sql)) expect(sql.slice(s.from, s.to)).toBe(s.text)
  })

  it.each([
    ['a string', "SELECT 'a;b'; SELECT 2", ["SELECT 'a;b'", 'SELECT 2']],
    ['a doubled quote', "SELECT 'it''s; fine'; SELECT 2", ["SELECT 'it''s; fine'", 'SELECT 2']],
    ['an E-string escape', "SELECT E'a\\';b'; SELECT 2", ["SELECT E'a\\';b'", 'SELECT 2']],
    ['a quoted name', 'SELECT "a;b" FROM t; SELECT 2', ['SELECT "a;b" FROM t', 'SELECT 2']],
    [
      'a dollar-quoted body',
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END $$ LANGUAGE plpgsql; SELECT 2',
      [
        'CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END $$ LANGUAGE plpgsql',
        'SELECT 2',
      ],
    ],
    [
      'a tagged dollar quote holding $$',
      'DO $fn$ SELECT $$;$$; $fn$; SELECT 2',
      ['DO $fn$ SELECT $$;$$; $fn$', 'SELECT 2'],
    ],
    ['a line comment', 'SELECT 1 -- not here; \n; SELECT 2', ['SELECT 1 -- not here;', 'SELECT 2']],
    [
      'a nested block comment',
      'SELECT /* a /* b; */ c; */ 1; SELECT 2',
      ['SELECT /* a /* b; */ c; */ 1', 'SELECT 2'],
    ],
  ])('ignores a semicolon in %s', (_, sql, expected) => {
    expect(texts(sql)).toEqual(expected)
  })

  it('takes $1 as a parameter, not a quote', () => {
    expect(texts('SELECT $1; SELECT $2')).toEqual(['SELECT $1', 'SELECT $2'])
  })

  it('leaves out a statement of comments only', () => {
    expect(texts('SELECT 1; -- the end\n/* really */')).toEqual(['SELECT 1'])
  })

  it('keeps an unterminated string to the end, for the database to refuse', () => {
    expect(texts("SELECT 'oops; SELECT 2")).toEqual(["SELECT 'oops; SELECT 2"])
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3'
  const statements = splitStatements(sql)

  it('picks the statement the cursor is in', () => {
    expect(statementAt(statements, sql.indexOf('2'))?.text).toBe('SELECT 2')
  })

  it('picks the one before when the cursor is after its semicolon', () => {
    expect(statementAt(statements, sql.indexOf('2;') + 2)?.text).toBe('SELECT 2')
  })

  it('picks the first when the cursor is before everything, and null for nothing', () => {
    expect(statementAt(splitStatements('\n\nSELECT 1'), 0)?.text).toBe('SELECT 1')
    expect(statementAt([], 0)).toBeNull()
  })
})

describe('looksLikeWrite', () => {
  it.each([
    'UPDATE t SET a = 1',
    '  delete from t',
    'DROP TABLE t',
    '-- why\nTRUNCATE t',
    'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
    'ALTER TABLE t ADD c int',
  ])('takes %j for a write', (sql) => {
    expect(looksLikeWrite(sql)).toBe(true)
  })

  it.each(['SELECT * FROM t', 'EXPLAIN SELECT 1', 'SHOW search_path', 'SELECT updated_at FROM t'])(
    'takes %j for a read',
    (sql) => {
      expect(looksLikeWrite(sql)).toBe(false)
    },
  )
})
