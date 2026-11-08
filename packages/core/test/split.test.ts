import { describe, expect, it } from 'vitest'
import { StatementSplitter } from '../src/backup/split.ts'

function split(...parts: string[]): string[] {
  const splitter = new StatementSplitter()
  const statements = parts.flatMap((part) => splitter.push(part))
  return [...statements, ...splitter.end()]
}

/** SQL with every kind of token that can hide a semicolon. */
const TRICKY = `-- a comment; with a semicolon
CREATE TABLE "we;ird ""name""" (a text DEFAULT 'it''s; fine', b text DEFAULT E'back\\\\slash\\'; quote');
/* block; /* nested; */ still comment; */ INSERT INTO t VALUES ('x');
CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT 'a;b' $$;
CREATE FUNCTION g() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  RETURN $$inner; quote$$ || 'x;' || "col;name";
END
$body$;
SELECT $1, a$b, $2 FROM t WHERE x = 'y'  ;
SELECT U&'d\\0061t;a', B'1010', X'1F', e'esc\\'aped;'
`

const EXPECTED = [
  `-- a comment; with a semicolon
CREATE TABLE "we;ird ""name""" (a text DEFAULT 'it''s; fine', b text DEFAULT E'back\\\\slash\\'; quote')`,
  `/* block; /* nested; */ still comment; */ INSERT INTO t VALUES ('x')`,
  `CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT 'a;b' $$`,
  `CREATE FUNCTION g() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  RETURN $$inner; quote$$ || 'x;' || "col;name";
END
$body$`,
  `SELECT $1, a$b, $2 FROM t WHERE x = 'y'`,
  `SELECT U&'d\\0061t;a', B'1010', X'1F', e'esc\\'aped;'`,
]

describe('StatementSplitter', () => {
  it('ends statements at semicolons outside strings, names, comments and dollar quotes', () => {
    expect(split(TRICKY)).toEqual(EXPECTED)
  })

  it('gives the same statements wherever the text is cut', () => {
    for (let cut = 0; cut <= TRICKY.length; cut += 1) {
      expect(split(TRICKY.slice(0, cut), TRICKY.slice(cut)), `cut at ${cut}`).toEqual(EXPECTED)
    }
  })

  it('gives the same statements a character at a time', () => {
    expect(split(...TRICKY)).toEqual(EXPECTED)
  })

  it('keeps the last statement, which may have no semicolon', () => {
    expect(split('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('drops empty statements and comments with nothing after them', () => {
    expect(split(';;  ;\n-- only a comment\n/* and another */\n')).toEqual([])
    expect(split('SELECT 1;\n-- the end\n')).toEqual(['SELECT 1'])
  })

  it('tells an E string from a word ending in e', () => {
    // In CASE'x' the quote follows a word, so the backslash is literal and the string ends at '.
    expect(split("SELECT CASE'\\';SELECT 2")).toEqual(["SELECT CASE'\\'", 'SELECT 2'])
    expect(split("SELECT E'\\';';SELECT 2")).toEqual(["SELECT E'\\';'", 'SELECT 2'])
  })

  it('takes $ in a word or a parameter as part of it, not a dollar quote', () => {
    expect(split('SELECT a$b$c, $1$;SELECT 2')).toEqual(['SELECT a$b$c, $1$', 'SELECT 2'])
  })

  it('reads a tag cut in the middle', () => {
    expect(split('SELECT $ta', 'g$ ; $tag$; SELECT 2')).toEqual([
      'SELECT $tag$ ; $tag$',
      'SELECT 2',
    ])
  })

  it('keeps a function’s BEGIN ATOMIC body whole, CASE … END inside it too, as psql does', () => {
    const body = `CREATE OR REPLACE FUNCTION public.f(begin_at int) RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN begin_at > 0 THEN 1 ELSE 0 END;
  SELECT 2;
END`
    const procedure = 'CREATE PROCEDURE p() BEGIN ATOMIC INSERT INTO t VALUES (1); END'
    const sql = `${body};\n${procedure};\nSELECT 'begin'; BEGIN; SELECT 1; END;`
    const expected = [body, procedure, "SELECT 'begin'", 'BEGIN', 'SELECT 1', 'END']
    expect(split(sql)).toEqual(expected)
    for (let cut = 0; cut <= sql.length; cut += 1) {
      expect(split(sql.slice(0, cut), sql.slice(cut)), `cut at ${cut}`).toEqual(expected)
    }
  })

  it('keeps a semicolon inside parentheses in its statement, as psql does', () => {
    expect(split('SELECT (1; 2); SELECT 3')).toEqual(['SELECT (1; 2)', 'SELECT 3'])
  })

  it('refuses SQL that ends inside a string, a name, a comment or a dollar quote', () => {
    expect(() => split("SELECT 'open")).toThrow('The SQL ends inside a string.')
    expect(() => split('SELECT "open')).toThrow('The SQL ends inside a quoted name.')
    expect(() => split('SELECT /* open')).toThrow('The SQL ends inside a comment.')
    expect(() => split('SELECT $$ open')).toThrow('The SQL ends inside a dollar-quoted string.')
  })

  it('reads megabytes of INSERTs quickly, in pieces of any size', () => {
    const row = `('a;b', 'it''s', E'x\\'y', 42, NULL)`
    const statement = `INSERT INTO "t" (a, b, c, d, e) VALUES\n${Array(50).fill(row).join(',\n')};\n`
    const sql = statement.repeat(2_500)
    const started = performance.now()
    const splitter = new StatementSplitter()
    let count = 0
    for (let at = 0; at < sql.length; at += 65_536)
      count += splitter.push(sql.slice(at, at + 65_536)).length
    count += splitter.end().length
    expect(count).toBe(2_500)
    expect(sql.length).toBeGreaterThan(4_000_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
