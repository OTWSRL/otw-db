import { connectionsFromEnv, driverKind, type ConnectionConfig } from '@otwdesign/db-core'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Where an app's own PostgreSQL is, by the names hosts and their database integrations give it,
 * the ones that don't go through a transaction pooler first: Neon's DATABASE_URL_UNPOOLED,
 * Vercel Postgres's and Supabase's POSTGRES_URL_NON_POOLING. The tool reads through cursors and
 * sets things for a session, which a pooler that hands each statement to another connection
 * doesn't keep.
 */
export const OWN_DATABASE = [
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
  'DATABASE_URL',
  'POSTGRES_URL',
] as const

/**
 * The connections of an app: those it names (`DB_ADMIN_<NAME>_URL`), or, when it names none, its
 * own database, read-only unless `DB_ADMIN_APP_ACCESS=write`. An address the tool can't open
 * (Prisma's `prisma://`, MongoDB's) is passed over, not refused: it's the app's, set for the app.
 */
export function appConnections(env: Env = process.env): ConnectionConfig[] {
  const named = connectionsFromEnv(env)
  if (named.length) return named
  for (const variable of OWN_DATABASE) {
    const url = env[variable]?.trim()
    if (!url) continue
    try {
      driverKind(url)
    } catch {
      continue
    }
    return [
      {
        name: 'app',
        label: 'This app',
        url,
        access: env.DB_ADMIN_APP_ACCESS?.trim() === 'write' ? 'write' : 'read',
      },
    ]
  }
  return []
}
