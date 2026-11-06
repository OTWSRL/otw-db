import { driverKind } from '../connections.ts'
import type { ConnectionConfig, Driver } from '../types.ts'
import { mysqlDriver } from './mysql.ts'
import { postgresDriver } from './postgres.ts'
import { sqliteDriver } from './sqlite.ts'

/** The driver for a connection, by its URL's scheme. It connects on first use. */
export function openDriver(connection: ConnectionConfig): Driver {
  const kind = driverKind(connection.url, `Connection "${connection.name}"`)
  if (kind === 'postgres') return postgresDriver(connection.url)
  if (kind === 'mysql') return mysqlDriver(connection.url)
  return sqliteDriver(connection.url)
}
