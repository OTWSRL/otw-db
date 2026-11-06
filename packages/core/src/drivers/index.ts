import { driverKind } from '../connections.ts'
import { DbAdminError } from '../errors.ts'
import type { ConnectionConfig, Driver } from '../types.ts'
import { postgresDriver } from './postgres.ts'

/** The driver for a connection, by its URL's scheme. It connects on first use. */
export function openDriver(connection: ConnectionConfig): Driver {
  const kind = driverKind(connection.url, `Connection "${connection.name}"`)
  if (kind === 'postgres') return postgresDriver(connection.url)
  throw new DbAdminError(
    `Connection "${connection.name}" is ${kind === 'mysql' ? 'MySQL' : 'SQLite'}, which isn't supported yet.`,
    501,
    'driver-unsupported',
  )
}
