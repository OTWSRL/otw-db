/*
 * The app's own users who may open the database without the password: DB_ADMIN_USERS, their
 * emails (or ids, as the app's sign-in names them) separated by commas.
 */

/** The list, from `DB_ADMIN_USERS`'s value: trimmed, lower-cased, empty entries dropped. */
export function listedUsers(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Which of `names` (an email, an id) is on the list, as the list has it; undefined for none. */
export function listedAs(
  listed: ReadonlySet<string>,
  names: readonly (string | null | undefined)[],
): string | undefined {
  for (const name of names) {
    const entry = name?.trim().toLowerCase()
    if (entry && listed.has(entry)) return entry
  }
  return undefined
}
