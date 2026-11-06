import type { Access, ConnectionConfig, ConnectionTag, DriverKind } from './types.ts'

type Env = Readonly<Record<string, string | undefined>>

const URL_VARIABLE = /^DB_ADMIN_([A-Z0-9]+(?:_[A-Z0-9]+)*)_URL$/
const TAGS: readonly ConnectionTag[] = ['local', 'development', 'testing', 'staging', 'production']
const SCHEMES: Record<string, DriverKind> = {
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
  'mysql:': 'mysql',
  'mariadb:': 'mysql',
  'sqlite:': 'sqlite',
  'file:': 'sqlite',
}

/**
 * Connections from the environment: `DB_ADMIN_<NAME>_URL`, with `DB_ADMIN_<NAME>_ACCESS`
 * (`read`, the default, or `write`), `DB_ADMIN_<NAME>_LABEL` and `DB_ADMIN_<NAME>_TAG` (`local`,
 * `development`, `testing`, `staging` or `production`). `DB_ADMIN_SHOP_DATA_URL` becomes the
 * connection `shop-data`. Sorted by name; an empty URL is skipped.
 */
export function connectionsFromEnv(env: Env = process.env): ConnectionConfig[] {
  const connections: ConnectionConfig[] = []
  for (const [variable, value] of Object.entries(env)) {
    const match = URL_VARIABLE.exec(variable)
    const url = value?.trim()
    if (!match || !url) continue
    const prefix = `DB_ADMIN_${match[1]}`
    driverKind(url, variable)
    const label = env[`${prefix}_LABEL`]?.trim()
    const tag = tagOf(env, `${prefix}_TAG`)
    connections.push({
      name: match[1]!.toLowerCase().replaceAll('_', '-'),
      url,
      access: access(env, `${prefix}_ACCESS`),
      ...(label ? { label } : {}),
      ...(tag ? { tag } : {}),
    })
  }
  return connections.sort((a, b) => a.name.localeCompare(b.name))
}

function access(env: Env, variable: string): Access {
  const value = env[variable]?.trim() || 'read'
  if (value === 'read' || value === 'write') return value
  throw new Error(`${variable} must be "read" or "write", not "${env[variable]}".`)
}

function tagOf(env: Env, variable: string): ConnectionTag | undefined {
  const value = env[variable]?.trim()
  if (!value) return undefined
  if ((TAGS as readonly string[]).includes(value)) return value as ConnectionTag
  throw new Error(`${variable} must be one of ${TAGS.join(', ')}, not "${value}".`)
}

/** Which driver opens `url`, by its scheme. `source` names where it came from, for the error. */
export function driverKind(url: string, source = 'The connection URL'): DriverKind {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0].toLowerCase()
  const kind = scheme ? SCHEMES[scheme] : undefined
  if (!kind) {
    // The scheme only: the rest may hold a password.
    const given = scheme ? `"${scheme}"` : 'an address without a scheme'
    throw new Error(
      `${source} must start with postgres://, mysql://, mariadb:// or sqlite: (or file:), not ${given}.`,
    )
  }
  return kind
}
