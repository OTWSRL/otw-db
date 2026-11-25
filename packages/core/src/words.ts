/*
 * A PostgreSQL statement's first words, read the way the server reads them. What refuses a
 * statement by how it starts (a restore's COMMIT, a read-only connection's COPY) must see the
 * word the server will, whatever comments and line ends are put before it.
 */

/**
 * Where the SQL goes on from `at`, past spaces and comments, as PostgreSQL reads them: a `--`
 * comment ends at a line feed or a carriage return, whichever comes first, and block comments
 * nest. Read otherwise, a word after a carriage return would be taken for part of the comment
 * here and for SQL by the server.
 */
export function pastComments(statement: string, from: number): number {
  let at = from
  for (;;) {
    while (/\s/.test(statement[at] ?? '')) at += 1
    if (statement.startsWith('--', at)) {
      const end = statement.slice(at).search(/[\n\r]/)
      if (end === -1) return statement.length
      at += end + 1
    } else if (statement.startsWith('/*', at)) {
      let depth = 0
      do {
        if (statement.startsWith('/*', at)) {
          depth += 1
          at += 2
        } else if (statement.startsWith('*/', at)) {
          depth -= 1
          at += 2
        } else at += 1
      } while (depth > 0 && at < statement.length)
    } else return at
  }
}

/**
 * The statement's first two words with one space between, past the comments and spaces before
 * and between them: `PREPARE TRANSACTION`, however it's written.
 */
export function firstWords(statement: string): string {
  const words: string[] = []
  let at = 0
  while (words.length < 2) {
    at = pastComments(statement, at)
    const word = /^[A-Za-z_]+/.exec(statement.slice(at, at + 64))?.[0]
    if (!word) break
    words.push(word)
    at += word.length
  }
  return words.join(' ')
}

/**
 * The statement's first word in capitals, past spaces, comments, brackets and empty statements
 * (`;COPY …` is COPY to the server). Read a character at a time: a pattern for "any number of
 * comments" tries every way to split them when no word follows, and a statement of a hundred
 * characters can hold the thread for hours.
 */
export function leadingWord(sql: string): string {
  let at = 0
  for (;;) {
    at = pastComments(sql, at)
    if (sql[at] === ';' || sql[at] === '(') at += 1
    else break
  }
  return (/^[A-Za-z_]+/.exec(sql.slice(at, at + 64))?.[0] ?? '').toUpperCase()
}
