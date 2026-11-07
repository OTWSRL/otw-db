import { driverKind } from '../connections.ts'
import type { ConnectionConfig, Driver } from '../types.ts'
import { mysqlDriver } from './mysql.ts'
import { postgresDriver, type PostgresOptions } from './postgres.ts'
import { sqliteDriver } from './sqlite.ts'

/** What the drivers are given, by kind: PostgreSQL's packages, for one. */
export interface DriverOptions {
  /** Where a PostgreSQL connection's pg and pg-cursor come from. */
  postgres?: PostgresOptions
}

/** The driver for a connection, by its URL's scheme. It connects on first use. */
export function openDriver(connection: ConnectionConfig, options: DriverOptions = {}): Driver {
  const kind = driverKind(connection.url, `Connection "${connection.name}"`)
  if (kind === 'postgres') return postgresDriver(connection.url, options.postgres)
  if (kind === 'mysql') return mysqlDriver(connection.url)
  return sqliteDriver(connection.url)
}
