import { createDbRoute } from '@otwdesign/db-next'

// OTW DB at /db: its page, its files and its API, all in this one route.
// Who gets in: anyone with DB_ADMIN_PASSWORD, and the app's signed-in users listed in
// DB_ADMIN_USERS (their emails, comma-separated), who need no password.
// Which databases: DB_ADMIN_<NAME>_URL, or the app's own (DATABASE_URL), read-only.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST } = createDbRoute()
