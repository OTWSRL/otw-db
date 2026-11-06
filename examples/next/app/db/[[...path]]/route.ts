import { dbAdmin } from '../../../db-admin'

// The tool's page, its files and its API: one Fetch handler for the whole of /db.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = (request: Request) => dbAdmin.fetch(request)
export const POST = (request: Request) => dbAdmin.fetch(request)
