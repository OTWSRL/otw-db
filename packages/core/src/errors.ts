/** An error the API answers with its own status and message, rather than a 500. */
export class DbAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable, such as `unknown-connection`. */
    readonly code: string,
  ) {
    super(message)
    this.name = 'DbAdminError'
  }
}

/** The database refused a statement: the SQL's fault, not the server's. */
export class QueryError extends DbAdminError {
  constructor(
    message: string,
    /** The database's own code, such as PostgreSQL's SQLSTATE `42P01`. */
    readonly sqlState: string | undefined,
    readonly details: {
      /** Where in the SQL, counting characters from 1. */
      position?: number
      detail?: string
      hint?: string
    } = {},
  ) {
    super(message, 400, 'query-failed')
    this.name = 'QueryError'
  }
}

/** The database couldn't be reached, or dropped the connection. */
export class ConnectionError extends DbAdminError {
  constructor(message: string) {
    super(message, 502, 'connection-failed')
    this.name = 'ConnectionError'
  }
}
