/**
 * What the address names, so a reload comes back to it: `#main` is connection main at its own
 * database, `#main/archive` at the server's database archive. Connection names have no `/`.
 */
export interface Address {
  /** Empty for the connection list. */
  connection: string
  /** Null for the connection's own database. */
  database: string | null
}

const decode = (part: string): string | null => {
  try {
    return decodeURIComponent(part)
  } catch {
    // Escapes that don't decode: as if nothing were named.
    return null
  }
}

/** The address in `hash` (`location.hash`). */
export function readAddress(hash: string): Address {
  const text = hash.replace(/^#/, '')
  const slash = text.indexOf('/')
  const connection = decode(slash === -1 ? text : text.slice(0, slash)) ?? ''
  const database = slash === -1 ? null : decode(text.slice(slash + 1)) || null
  return { connection, database }
}

/** The hash for `address`, without its `#`. */
export function addressOf({ connection, database }: Address): string {
  if (!connection) return ''
  const name = encodeURIComponent(connection)
  return database ? `${name}/${encodeURIComponent(database)}` : name
}

/**
 * The key tabs and history are kept under in the browser: the connection's name for its own
 * database, as before it could open others, and `name/database` for each other.
 */
export function storageScope(connection: string, database: string | null): string {
  return database ? `${connection}/${database}` : connection
}
