/**
 * PostgreSQL's SQL cut into statements as it streams in, the way psql reads a file: a semicolon
 * ends a statement unless it's inside a string ('…', E'…', $tag$…$tag$), a quoted name ("…") or a
 * comment (-- … and nested /* … *\/), inside parentheses, or inside a function's BEGIN ATOMIC …
 * END body. Text may arrive cut anywhere, even inside a string or a dollar quote's tag. A
 * statement keeps the comments inside and before it; comments with nothing after them are
 * dropped.
 *
 * standard_conforming_strings is taken as on, PostgreSQL's default since 9.1: a backslash is
 * literal in '…' and escapes only in E'…'.
 */
export class StatementSplitter {
  #text = ''
  /** Where the statement being read starts in #text. */
  #start = 0
  /** How far #text has been read. */
  #at = 0
  #state: State = 'code'
  /** Block comments nest in PostgreSQL. */
  #depth = 0
  /** The dollar quote's closing delimiter, such as `$body$`. */
  #close = ''
  /** Whether the statement so far has anything but comments and spaces. */
  #code = false
  /** Parentheses open, and BEGIN … END blocks open in a function's body: psql's heuristic. */
  #parens = 0
  #begins = 0
  /** Words read in the statement, and the first letters of the first four that matter. */
  #words = 0
  #head = ''

  /** Reads `text` and returns the statements it completes, without their semicolons. */
  push(text: string): string[] {
    // Drop what earlier statements took, once per push rather than once per statement.
    if (this.#start > 0) {
      this.#text = this.#text.slice(this.#start)
      this.#at -= this.#start
      this.#start = 0
    }
    this.#text += text
    return this.#read(false)
  }

  /** The statement left at the end, if any: the last one may have no semicolon. */
  end(): string[] {
    const done = this.#read(true)
    if (this.#state !== 'code' && this.#state !== 'line-comment') {
      throw new Error(`The SQL ends inside ${UNFINISHED[this.#state]}.`)
    }
    const last = this.#code ? this.#text.slice(this.#start).trim() : ''
    this.#text = ''
    this.#start = 0
    this.#at = 0
    this.#code = false
    this.#state = 'code'
    this.#restart()
    return last ? [...done, last] : done
  }

  #restart(): void {
    this.#parens = 0
    this.#begins = 0
    this.#words = 0
    this.#head = ''
  }

  /**
   * psql's way to find a SQL-standard function body (BEGIN ATOMIC … END), whose semicolons don't
   * end the statement: in CREATE [OR REPLACE] FUNCTION or PROCEDURE, outside parentheses, BEGIN
   * opens a block and END closes one, as CASE, which also ends with END, does inside one.
   */
  #word(word: string): void {
    const lower = word.toLowerCase()
    if (this.#words < 4) this.#head += TRACKED.has(lower) ? lower[0] : ' '
    this.#words += 1
    const h = this.#head
    const routine =
      h[0] === 'c' &&
      (h[1] === 'f' ||
        h[1] === 'p' ||
        (h[1] === 'o' && h[2] === 'r' && (h[3] === 'f' || h[3] === 'p')))
    if (!routine || this.#parens !== 0) return
    if (lower === 'begin') this.#begins += 1
    else if (lower === 'case' && this.#begins >= 1) this.#begins += 1
    else if (lower === 'end' && this.#begins > 0) this.#begins -= 1
  }

  /** Reads as far as the text allows; `final` when no more is coming. */
  #read(final: boolean): string[] {
    const done: string[] = []
    const s = this.#text
    const n = s.length
    /** Whether the character at `i` hasn't arrived yet, though more text may. */
    const waiting = (i: number) => !final && i >= n
    let at = this.#at
    read: while (at < n) {
      switch (this.#state) {
        case 'code': {
          const c = s.charCodeAt(at)
          if (c === SEMICOLON && this.#parens === 0 && this.#begins === 0) {
            const statement = s.slice(this.#start, at).trim()
            if (this.#code && statement) done.push(statement)
            this.#start = at + 1
            this.#code = false
            this.#restart()
            at += 1
          } else if (
            wordStart(c) &&
            !identifierChar(at > this.#start ? s.charCodeAt(at - 1) : NaN)
          ) {
            let end = at + 1
            while (end < n && identifierChar(s.charCodeAt(end))) end += 1
            // The word may go on in the text still to come.
            if (waiting(end)) break read
            this.#code = true
            this.#word(s.slice(at, end))
            at = end
          } else if (c === OPEN || c === CLOSE) {
            this.#code = true
            if (c === OPEN) this.#parens += 1
            else if (this.#parens > 0) this.#parens -= 1
            at += 1
          } else if (c === QUOTE) {
            this.#code = true
            this.#state = escapeStringStarts(s, at, this.#start) ? 'escape-string' : 'string'
            at += 1
          } else if (c === DOUBLE_QUOTE) {
            this.#code = true
            this.#state = 'name'
            at += 1
          } else if ((c === DASH || c === SLASH) && waiting(at + 1)) {
            break read
          } else if (c === DASH && s.charCodeAt(at + 1) === DASH) {
            this.#state = 'line-comment'
            at += 2
          } else if (c === SLASH && s.charCodeAt(at + 1) === STAR) {
            this.#state = 'block-comment'
            this.#depth = 1
            at += 2
          } else if (
            c === DOLLAR &&
            !identifierChar(at > this.#start ? s.charCodeAt(at - 1) : NaN)
          ) {
            const tag = dollarTag(s, at, final)
            if (tag === undefined) break read
            this.#code = true
            if (tag === null) at += 1
            else {
              this.#state = 'dollar'
              this.#close = tag
              at += tag.length
            }
          } else {
            if (!whitespace(c)) this.#code = true
            at += 1
          }
          break
        }
        case 'string':
        case 'name': {
          const quote = this.#state === 'string' ? "'" : '"'
          const end = s.indexOf(quote, at)
          if (end === -1) {
            at = n
            break read
          }
          // A doubled quote is a quote inside: wait to see the next character.
          if (waiting(end + 1)) {
            at = end
            break read
          }
          if (s[end + 1] === quote) at = end + 2
          else {
            this.#state = 'code'
            at = end + 1
          }
          break
        }
        case 'escape-string': {
          const c = s.charCodeAt(at)
          if ((c === BACKSLASH || c === QUOTE) && waiting(at + 1)) break read
          if (c === BACKSLASH) at += 2
          else if (c === QUOTE && s.charCodeAt(at + 1) === QUOTE) at += 2
          else if (c === QUOTE) {
            this.#state = 'code'
            at += 1
          } else at += 1
          break
        }
        case 'line-comment': {
          const end = s.indexOf('\n', at)
          if (end === -1) {
            at = n
            break read
          }
          this.#state = 'code'
          at = end + 1
          break
        }
        case 'block-comment': {
          const c = s.charCodeAt(at)
          if ((c === STAR || c === SLASH) && waiting(at + 1)) break read
          if (c === STAR && s.charCodeAt(at + 1) === SLASH) {
            this.#depth -= 1
            if (this.#depth === 0) this.#state = 'code'
            at += 2
          } else if (c === SLASH && s.charCodeAt(at + 1) === STAR) {
            this.#depth += 1
            at += 2
          } else at += 1
          break
        }
        case 'dollar': {
          const end = s.indexOf(this.#close, at)
          if (end === -1) {
            // The closing tag may have begun at the very end: look again from there.
            at = Math.max(at, n - this.#close.length + 1)
            break read
          }
          this.#state = 'code'
          at = end + this.#close.length
          break
        }
      }
    }
    this.#at = at
    return done
  }
}

type State =
  'code' | 'string' | 'escape-string' | 'name' | 'line-comment' | 'block-comment' | 'dollar'

const SEMICOLON = 59
const QUOTE = 39
const DOUBLE_QUOTE = 34
const DASH = 45
const SLASH = 47
const STAR = 42
const DOLLAR = 36
const BACKSLASH = 92
const OPEN = 40
const CLOSE = 41

/** The words psql looks at to tell CREATE [OR REPLACE] FUNCTION or PROCEDURE. */
const TRACKED = new Set(['create', 'or', 'replace', 'function', 'procedure'])

const UNFINISHED: Record<State, string> = {
  code: 'a statement',
  string: 'a string',
  'escape-string': 'a string',
  name: 'a quoted name',
  'line-comment': 'a comment',
  'block-comment': 'a comment',
  dollar: 'a dollar-quoted string',
}

function whitespace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13)
}

/** Letters, digits, `_` and `$`, and anything past ASCII, which PostgreSQL takes as letters. */
function identifierChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === DOLLAR ||
    c >= 128
  )
}

/** A letter, `_`, or anything past ASCII: what a word (a keyword, a name) starts with. */
function wordStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128
}

/** Whether the quote at `at` opens an E'…' string: an E or e that starts a word, just before. */
function escapeStringStarts(s: string, at: number, start: number): boolean {
  if (at - 1 < start) return false
  const e = s.charCodeAt(at - 1)
  if (e !== 69 && e !== 101) return false
  return at - 2 < start || !identifierChar(s.charCodeAt(at - 2))
}

/**
 * The dollar quote opening at `at` (`$$` or `$tag$`); null when it's not one ($1, a stray $);
 * undefined when the text stops before it can tell.
 */
function dollarTag(s: string, at: number, final: boolean): string | null | undefined {
  // A tag is an identifier, at most 63 bytes, that doesn't start with a digit.
  for (let end = at + 1; end <= at + 65; end += 1) {
    if (end >= s.length) return final ? null : undefined
    const c = s.charCodeAt(end)
    if (c === DOLLAR) return s.slice(at, end + 1)
    if (!identifierChar(c) || (end === at + 1 && c >= 48 && c <= 57)) return null
  }
  return null
}
