import { driverKind } from './connections.ts'
import { openDriver } from './drivers/index.ts'
import { DbAdminError, QueryError } from './errors.ts'
import { EXPORT_TYPES, exportStream } from './export.ts'
import type {
  Access,
  AuditEvent,
  Change,
  ConnectionConfig,
  Driver,
  ExportFormat,
  Filter,
  FilterOperator,
  Limits,
  RowsRequest,
  Viewer,
} from './types.ts'
import { ROUTES } from './routes.ts'
import type * as BackupApi from './backup/api.ts'
import { renderAsset, renderIndex, type UiAssets } from './ui.ts'

/** What `createDbAdmin` needs: who may use the tool, the databases it may open, its limits. */
export interface DbAdminOptions {
  /** Where the host mounts it, such as `/db`; empty for the root. */
  basePath?: string
  /**
   * Who is asking, or null to refuse (401). Required: without it nothing is served. Read the
   * host's own session here: a cookie, a header, or your auth library.
   */
  authorize(request: Request): Viewer | null | Promise<Viewer | null>
  /** The databases it may open, such as `connectionsFromEnv()`. */
  connections: readonly ConnectionConfig[]
  /** Receives every statement run. Defaults to one JSON line on stdout; `false` turns it off. */
  audit?: ((event: AuditEvent) => void | Promise<void>) | false
  /** Defaults: 1,000 rows and 30 seconds per statement. */
  limits?: Partial<Limits>
  /**
   * Origins allowed besides the request's own host, for a proxy that changes the Host header.
   * Such as `https://admin.example.com`.
   */
  origins?: readonly string[]
  /** Opens a connection's driver; a host replaces it to hand over a connection it already has. */
  driver?(connection: ConnectionConfig): Driver
  /**
   * The browser app's files, loaded on the first page view. Defaults to `@otwdesign/db-ui`'s;
   * `false` serves the API alone.
   */
  ui?: (() => Promise<UiAssets>) | false
  /** Where the app sends a browser the API turns away (401): the host's sign-in page. */
  signInUrl?: string
  /** Backups and restores (PostgreSQL). A restore's upload waits in the database it restores. */
  backups?: {
    /** The biggest backup a restore takes, in bytes. Defaults to 1 GiB. */
    maxRestoreBytes?: number
  }
}

/**
 * One endpoint, relative to the base path, for hosts that register routes one by one. A segment
 * starting with `:` is a parameter, as `/assets/:file`; the handler reads it from the URL.
 */
export interface DbAdminRoute {
  method: 'GET' | 'POST'
  path: string
  handler(request: Request): Promise<Response>
}

/** The tool `createDbAdmin` returns: one Fetch handler, serving the app and its API. */
export interface DbAdmin {
  readonly basePath: string
  /** A standard Fetch handler: Next.js route handlers, Hono, Bun and Deno take it as it is. */
  fetch(request: Request): Promise<Response>
  /**
   * The patterns to register the handler under, for routers that take routes one by one (see
   * ROUTES): each answers through `fetch`, which tells the endpoints apart.
   */
  readonly routes: readonly DbAdminRoute[]
  /** Closes every connection it opened. */
  close(): Promise<void>
}

/** The limits when the options set none: 1,000 rows and 30 seconds per statement. */
export const DEFAULT_LIMITS: Limits = { maxRows: 1_000, timeoutMs: 30_000 }
const MAX_PAGE = 1_000
const MAX_BODY = 1_048_576
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const QUERY_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_FILTERS = 20
const MAX_CHANGES = 1_000
const MAX_LIST = 1_000
/** A connection's other databases kept open at once; the one used longest ago closes first. */
const MAX_DATABASES = 8
/** PostgreSQL's NAMEDATALEN, less its terminator: the longest database name, in bytes. */
const MAX_DATABASE_NAME = 63
const OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  '=',
  '<>',
  '<',
  '>',
  '<=',
  '>=',
  'in',
  'not in',
  'between',
  'not between',
  'is null',
  'is not null',
  'like',
  'not like',
  'contains',
  'not contains',
  'starts with',
  'ends with',
])
/** Sent by the browser app on every call; a form on another site can't send it. */
export const CSRF_HEADER = 'x-db-admin'

/** The database manager as one Fetch handler, its API under `{basePath}/api/`. */
export function createDbAdmin(options: DbAdminOptions): DbAdmin {
  if (typeof options?.authorize !== 'function') {
    throw new Error('createDbAdmin() needs authorize(request), so it knows who may use it.')
  }
  const basePath = normalizeBase(options.basePath ?? '')
  const connections = new Map<string, ConnectionConfig>()
  for (const connection of options.connections) {
    if (!NAME.test(connection.name)) {
      throw new Error(
        `Connection names are lowercase letters, digits and hyphens, not "${connection.name}".`,
      )
    }
    if (connections.has(connection.name)) {
      throw new Error(`Two connections are named "${connection.name}".`)
    }
    driverKind(connection.url, `Connection "${connection.name}"`)
    connections.set(connection.name, connection)
  }
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const audit = options.audit === false ? undefined : (options.audit ?? logAudit)
  const drivers = new Map<string, Driver>()
  /** Each connection's other databases' drivers, the one used last at the end. */
  const others = new Map<string, Map<string, Driver>>()
  const running = new Map<string, { viewer: string; controller: AbortController }>()
  const open = options.driver ?? openDriver
  const loadUi = options.ui === false ? undefined : (options.ui ?? defaultUi)
  let ui: Promise<UiAssets> | undefined
  // Loaded on the first backup or restore: a host that never makes one never loads it.
  let backupApi: Promise<typeof BackupApi> | undefined
  const backups = () => (backupApi ??= import('./backup/api.ts'))
  const maxRestoreBytes = options.backups?.maxRestoreBytes ?? 1_073_741_824
  /** What a backup endpoint needs to know, from the connection it reached. */
  const backupContext = (target: ReturnType<typeof reach>, viewer: Viewer) => ({
    ...target,
    viewer,
    record,
    maxRestoreBytes,
  })

  function driver(connection: ConnectionConfig): Driver {
    let found = drivers.get(connection.name)
    if (!found) {
      found = open(connection)
      drivers.set(connection.name, found)
    }
    return found
  }

  /**
   * The driver for one of the connection's other databases. The 8 used last stay open; opening a
   * ninth closes the one used longest ago, so a viewer can't keep pools open without end.
   */
  function driverAt(connection: ConnectionConfig, database: string): Driver {
    let open = others.get(connection.name)
    if (!open) others.set(connection.name, (open = new Map()))
    let found = open.get(database)
    if (found) open.delete(database)
    else found = driver(connection).withDatabase!(database)
    open.set(database, found)
    if (open.size > MAX_DATABASES) {
      const [oldest, evicted] = open.entries().next().value!
      open.delete(oldest)
      evicted.close().catch((error: unknown) => {
        console.error(`otw-db: could not close database "${oldest}" of "${connection.name}"`, error)
      })
    }
    return found
  }

  /**
   * The connection by name, with this viewer's access to it and the driver for `database`: one of
   * the server's other databases, or the connection's own when none is named. Unknown and hidden
   * connections look the same.
   */
  function reach(
    viewer: Viewer,
    name: unknown,
    database?: unknown,
  ): { connection: ConnectionConfig; access: Access; db: Driver; database?: string } {
    const connection = typeof name === 'string' ? connections.get(name) : undefined
    const access = connection ? accessOf(viewer, connection) : null
    if (!connection || !access) {
      throw new DbAdminError(`There's no connection "${String(name)}".`, 404, 'unknown-connection')
    }
    if (database === undefined || database === null || database === '') {
      return { connection, access, db: driver(connection) }
    }
    const named = databaseName(database)
    if (!opensOthers(connection)) throw oneDatabase(connection)
    return { connection, access, db: driverAt(connection, named), database: named }
  }

  /** Whether the connection may open its server's other databases, and its driver can. */
  function opensOthers(connection: ConnectionConfig): boolean {
    if (connection.databases === 'one') return false
    const opened = driver(connection)
    return typeof opened.databases === 'function' && typeof opened.withDatabase === 'function'
  }

  async function record(event: Omit<AuditEvent, 'at'>): Promise<void> {
    if (!audit) return
    try {
      await audit({ at: new Date().toISOString(), ...event })
    } catch (error) {
      console.error('otw-db: the audit log failed', error)
    }
  }

  const endpoints: {
    method: 'GET' | 'POST'
    path: string
    run(request: Request, viewer: Viewer): Promise<unknown>
  }[] = [
    {
      method: 'GET',
      path: '/api/connections',
      async run(_request, viewer) {
        const visible = [...connections.values()].flatMap((connection) => {
          const access = accessOf(viewer, connection)
          if (!access) return []
          const kind = driverKind(connection.url)
          // A kind without a driver yet is listed, but can't be opened.
          let capabilities: Driver['capabilities'] | null = null
          try {
            const opened = driver(connection)
            capabilities = {
              ...opened.capabilities,
              databases: opensOthers(connection),
              backup: typeof opened.session === 'function',
            }
          } catch (error) {
            if (!(error instanceof DbAdminError)) throw error
          }
          const label = connection.label ?? connection.name
          const tag = connection.tag ?? null
          const warning = connection.warning ?? null
          return [{ name: connection.name, label, tag, warning, kind, access, capabilities }]
        })
        return { connections: visible }
      },
    },
    {
      method: 'GET',
      path: '/api/databases',
      async run(request, viewer) {
        const { connection, db } = reach(
          viewer,
          new URL(request.url).searchParams.get('connection'),
        )
        if (!opensOthers(connection)) throw oneDatabase(connection)
        return await db.databases!()
      },
    },
    {
      method: 'GET',
      path: '/api/tables',
      async run(request, viewer) {
        const params = new URL(request.url).searchParams
        const { db } = reach(viewer, params.get('connection'), params.get('database'))
        return { tables: await db.tables() }
      },
    },
    {
      method: 'GET',
      path: '/api/table',
      async run(request, viewer) {
        const params = new URL(request.url).searchParams
        const { db } = reach(viewer, params.get('connection'), params.get('database'))
        const table = await db.table(
          text(params.get('schema'), 'schema'),
          text(params.get('name'), 'name'),
        )
        if (!table) throw new DbAdminError("There's no such table.", 404, 'unknown-table')
        return { table }
      },
    },
    {
      method: 'GET',
      path: '/api/info',
      async run(request, viewer) {
        const params = new URL(request.url).searchParams
        const { db } = reach(viewer, params.get('connection'), params.get('database'))
        return { info: await db.info() }
      },
    },
    {
      method: 'POST',
      path: '/api/count',
      async run(request, viewer) {
        const body = await json(request)
        const { connection, db, database } = reach(viewer, body.connection, body.database)
        const target = {
          schema: text(body.schema, 'schema'),
          table: text(body.table, 'table'),
          filters: filtersOf(body.filters),
        }
        const started = performance.now()
        const statement = `count ${target.schema}.${target.table}`
        try {
          const rows = await db.count(target, {
            timeoutMs: limits.timeoutMs,
            signal: request.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'count',
            statement,
            durationMs: Math.round(performance.now() - started),
            rows,
          })
          return { count: rows }
        } catch (error) {
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'count',
            statement,
            durationMs: Math.round(performance.now() - started),
            error: (error as Error).message,
          })
          throw error
        }
      },
    },
    {
      method: 'POST',
      path: '/api/rows',
      async run(request, viewer) {
        const body = await json(request)
        const { connection, db, database } = reach(viewer, body.connection, body.database)
        const page = rowsRequest(body)
        const started = performance.now()
        const statement = `${page.schema}.${page.table}`
        try {
          const result = await db.rows(page, {
            timeoutMs: limits.timeoutMs,
            signal: request.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'rows',
            statement,
            durationMs: result.durationMs,
            rows: result.rows.length,
          })
          return result
        } catch (error) {
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'rows',
            statement,
            durationMs: Math.round(performance.now() - started),
            error: (error as Error).message,
          })
          throw error
        }
      },
    },
    {
      method: 'POST',
      path: '/api/query',
      async run(request, viewer) {
        const body = await json(request)
        const { connection, access, db, database } = reach(viewer, body.connection, body.database)
        const sql = text(body.sql, 'sql')
        const maxRows =
          body.maxRows === undefined
            ? limits.maxRows
            : count(body.maxRows, 'maxRows', 1, limits.maxRows)
        const queryId = body.queryId === undefined ? undefined : id(body.queryId)
        const controller = new AbortController()
        // The browser leaving stops the query too.
        const stop = () => controller.abort()
        request.signal.addEventListener('abort', stop, { once: true })
        if (queryId) {
          if (running.has(queryId)) {
            throw new DbAdminError(`Query "${queryId}" is already running.`, 409, 'query-running')
          }
          running.set(queryId, { viewer: viewer.id, controller })
        }
        const started = performance.now()
        try {
          const result = await db.query(sql, {
            access,
            maxRows,
            timeoutMs: limits.timeoutMs,
            signal: controller.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'query',
            statement: sql,
            durationMs: result.durationMs,
            rows: result.affectedRows ?? result.rows.length,
          })
          return result
        } catch (error) {
          await record({
            viewer: viewer.id,
            connection: connection.name,
            ...(database ? { database } : {}),
            action: 'query',
            statement: sql,
            durationMs: Math.round(performance.now() - started),
            error: (error as Error).message,
          })
          throw error
        } finally {
          request.signal.removeEventListener('abort', stop)
          if (queryId) running.delete(queryId)
        }
      },
    },
    {
      method: 'POST',
      path: '/api/apply',
      async run(request, viewer) {
        const body = await json(request)
        const { connection, access, db, database } = reach(viewer, body.connection, body.database)
        const target = { schema: text(body.schema, 'schema'), table: text(body.table, 'table') }
        const changes = changesOf(body.changes)
        const dryRun = body.dryRun === true
        if (access !== 'write') {
          throw new DbAdminError(`Connection "${connection.name}" is read-only.`, 403, 'read-only')
        }
        const started = performance.now()
        try {
          const result = await db.apply(target, changes, {
            timeoutMs: limits.timeoutMs,
            dryRun,
          })
          if (!dryRun) {
            await record({
              viewer: viewer.id,
              connection: connection.name,
              ...(database ? { database } : {}),
              action: 'apply',
              statement: result.statements.join(';\n'),
              durationMs: Math.round(performance.now() - started),
              rows: changes.length,
            })
          }
          return result
        } catch (error) {
          if (!dryRun) {
            await record({
              viewer: viewer.id,
              connection: connection.name,
              ...(database ? { database } : {}),
              action: 'apply',
              statement: `${changes.length} changes to ${target.schema}.${target.table}`,
              durationMs: Math.round(performance.now() - started),
              error: (error as Error).message,
            })
          }
          throw error
        }
      },
    },
    {
      method: 'POST',
      path: '/api/export',
      async run(request, viewer) {
        const body = await json(request)
        const { connection, db, database } = reach(viewer, body.connection, body.database)
        const format = formatOf(body.format)
        const page = rowsRequest({ ...body, limit: undefined, offset: undefined })
        const started = performance.now()
        const batches = db.export(page, { timeoutMs: limits.timeoutMs })
        // Read the first batch before answering, so a bad table or filter is a proper error.
        const first = await batches.next()
        let replayed = false
        const replay: AsyncIterator<{ columns: { name: string }[]; rows: (string | null)[][] }> = {
          next: async () => {
            if (replayed) return batches.next()
            replayed = true
            return first
          },
          return: async () => batches.return(undefined),
        }
        const stream = exportStream(
          format,
          replay,
          page,
          db.sql,
          (rows, error) =>
            void record({
              viewer: viewer.id,
              connection: connection.name,
              ...(database ? { database } : {}),
              action: 'export',
              statement: `${page.schema}.${page.table} as ${format}`,
              durationMs: Math.round(performance.now() - started),
              rows,
              ...(error ? { error: error.message } : {}),
            }),
        )
        const { type, extension } = EXPORT_TYPES[format]
        const file = `${page.table}.${extension}`.replace(/[^\w.-]+/g, '_')
        return new Response(stream, {
          headers: {
            'content-type': type,
            'content-disposition': `attachment; filename="${file}"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
    {
      method: 'GET',
      path: '/api/backup-options',
      async run(request, viewer) {
        const params = new URL(request.url).searchParams
        const target = reach(viewer, params.get('connection'), params.get('database'))
        return (await backups()).options(backupContext(target, viewer))
      },
    },
    ...(
      [
        ['/api/backup', 'download'],
        ['/api/restore-plan', 'plan'],
        ['/api/restore-start', 'start'],
        ['/api/restore-run', 'run'],
        ['/api/restore-discard', 'discard'],
      ] as const
    ).map(([path, action]) => ({
      method: 'POST' as const,
      path,
      async run(request: Request, viewer: Viewer) {
        const body = await json(request)
        const target = reach(viewer, body.connection, body.database)
        return (await backups())[action](backupContext(target, viewer), body)
      },
    })),
    {
      method: 'POST',
      path: '/api/restore-chunk',
      async run(request, viewer) {
        // The body is the piece itself; the rest comes in the address.
        const params = new URL(request.url).searchParams
        const target = reach(viewer, params.get('connection'), params.get('database'))
        return (await backups()).chunk(backupContext(target, viewer), request)
      },
    },
    {
      method: 'POST',
      path: '/api/cancel',
      async run(request, viewer) {
        const queryId = id((await json(request)).queryId)
        const query = running.get(queryId)
        // Only the viewer who started a query may stop it; others see no such query.
        if (!query || query.viewer !== viewer.id) return { canceled: false }
        query.controller.abort()
        return { canceled: true }
      },
    },
  ]

  const api: DbAdminRoute[] = endpoints.map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    handler: (request) => respond(request, (viewer) => endpoint.run(request, viewer)),
  }))

  /** The app's files hold no data, so they need no viewer: the API they call does. */
  function assets(): Promise<UiAssets> {
    ui ??= loadUi!().catch((error: unknown) => {
      ui = undefined
      throw error
    })
    return ui
  }
  const config = {
    api: `${basePath}/api`,
    ...(options.signInUrl ? { signInUrl: options.signInUrl } : {}),
  }
  const pages: DbAdminRoute[] = loadUi
    ? [
        {
          method: 'GET',
          path: '/',
          handler: () => page(async () => renderIndex(await assets(), basePath, config)),
        },
        {
          method: 'GET',
          path: '/assets/:file',
          handler: (request) =>
            page(async () =>
              renderAsset(await assets(), new URL(request.url).pathname.split('/').pop()!),
            ),
        },
      ]
    : []
  const serves = [...pages, ...api]

  async function respond(request: Request, run: (viewer: Viewer) => Promise<unknown>) {
    try {
      if (request.headers.get(CSRF_HEADER) !== '1') {
        throw new DbAdminError(`Requests need the ${CSRF_HEADER}: 1 header.`, 403, 'missing-header')
      }
      if (!sameOrigin(request, options.origins ?? [])) {
        throw new DbAdminError('Requests from other sites are refused.', 403, 'cross-origin')
      }
      const viewer = await options.authorize(request)
      if (!viewer) throw new DbAdminError('Sign in first.', 401, 'unauthorized')
      const answer = await run(viewer)
      // A download answers with its own response; everything else with JSON.
      return answer instanceof Response ? answer : reply(200, answer)
    } catch (error) {
      return failure(error)
    }
  }

  const admin: DbAdmin = {
    basePath,
    routes: ROUTES.filter((route) => loadUi || route.path.startsWith('/api/')).map((route) => ({
      method: route.method,
      path: route.path,
      handler: (request: Request) => admin.fetch(request),
    })),
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const within = pathname === basePath || pathname.startsWith(`${basePath}/`)
      const path = within ? pathname.slice(basePath.length) || '/' : null
      const matches = path === null ? [] : serves.filter((route) => pathMatches(route.path, path))
      const route = matches.find((r) => r.method === request.method)
      if (route) return route.handler(request)
      if (matches.length) {
        return reply(
          405,
          {
            error: {
              code: 'method-not-allowed',
              message: `Use ${matches.map((r) => r.method).join(' or ')}.`,
            },
          },
          { allow: matches.map((r) => r.method).join(', ') },
        )
      }
      return reply(404, { error: { code: 'not-found', message: 'Not found.' } })
    },
    async close() {
      const open = [...drivers.values(), ...[...others.values()].flatMap((o) => [...o.values()])]
      drivers.clear()
      others.clear()
      await Promise.all(open.map((d) => d.close()))
    },
  }
  return admin
}

/** A page's response, or a 500 when its files can't be loaded (a build that's missing). */
async function page(render: () => Promise<Response>): Promise<Response> {
  try {
    return await render()
  } catch (error) {
    console.error('otw-db: the browser app could not be loaded', error)
    return new Response('OTW DB could not load its browser app.', { status: 500 })
  }
}

/** Whether `path` fits the route's: the same segments, a `:name` one matching any. */
function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes(':')) return pattern === path
  const want = pattern.split('/')
  const have = path.split('/')
  return (
    want.length === have.length &&
    want.every((segment, i) => (segment.startsWith(':') ? have[i] !== '' : segment === have[i]))
  )
}

/** `@otwdesign/db-ui`'s files, imported on the first page view and never before. */
async function defaultUi(): Promise<UiAssets> {
  const { assets } = (await import('@otwdesign/db-ui')) as { assets: UiAssets }
  return assets
}

function oneDatabase(connection: ConnectionConfig): DbAdminError {
  return new DbAdminError(
    `Connection "${connection.name}" opens its own database only.`,
    400,
    'one-database',
  )
}

/** A database's name as PostgreSQL takes it: up to 63 bytes, with no NUL. */
function databaseName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    new TextEncoder().encode(value).length > MAX_DATABASE_NAME
  ) {
    throw bad('"database" is a database’s name.')
  }
  return value
}

function accessOf(viewer: Viewer, connection: ConnectionConfig): Access | null {
  const granted = viewer.access ? viewer.access(connection) : connection.access
  if (!granted) return null
  return granted === 'write' && connection.access === 'write' ? 'write' : 'read'
}

/** Segments of letters, digits and `. _ ~ -`: nothing a URL would encode, or HTML escape. */
const BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)*$/

function normalizeBase(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '')
  if (!BASE_PATH.test(trimmed)) {
    throw new Error(
      `basePath is a path such as "/db" or "/admin/db": segments of letters, digits, . _ ~ and -, not "${basePath}".`,
    )
  }
  return trimmed
}

/**
 * The browser's Origin, when it sends one, must be this host's (as the Host header, or a proxy's
 * X-Forwarded-Host, names it) or one of `origins`.
 */
function sameOrigin(request: Request, origins: readonly string[]): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  if (origins.includes(origin)) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const hosts = [
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
    request.headers.get('host'),
    new URL(request.url).host,
  ]
  return hosts.includes(host)
}

async function json(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new DbAdminError(
      'Send JSON, with Content-Type: application/json.',
      415,
      'unsupported-media-type',
    )
  }
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY) throw tooLarge()
  const body = await request.text()
  if (body.length > MAX_BODY) throw tooLarge()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new DbAdminError("The body isn't valid JSON.", 400, 'bad-request')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DbAdminError('The body is a JSON object.', 400, 'bad-request')
  }
  return parsed as Record<string, unknown>
}

function tooLarge() {
  return new DbAdminError('The request is larger than 1 MB.', 413, 'too-large')
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new DbAdminError(`"${field}" is required.`, 400, 'bad-request')
  }
  return value
}

function count(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DbAdminError(
      `"${field}" is a whole number from ${min} to ${max}.`,
      400,
      'bad-request',
    )
  }
  return value
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !QUERY_ID.test(value)) {
    throw new DbAdminError('"queryId" is up to 64 letters, digits, - and _.', 400, 'bad-request')
  }
  return value
}

function rowsRequest(body: Record<string, unknown>): RowsRequest {
  const order = body.order === undefined ? [] : body.order
  if (!Array.isArray(order) || order.length > 10) {
    throw new DbAdminError('"order" is a list of up to 10 columns.', 400, 'bad-request')
  }
  return {
    schema: text(body.schema, 'schema'),
    table: text(body.table, 'table'),
    limit: body.limit === undefined ? 100 : count(body.limit, 'limit', 1, MAX_PAGE),
    offset:
      body.offset === undefined ? 0 : count(body.offset, 'offset', 0, Number.MAX_SAFE_INTEGER),
    order: order.map((entry: unknown) => {
      const { column, descending } = (entry ?? {}) as { column?: unknown; descending?: unknown }
      if (descending !== undefined && typeof descending !== 'boolean') {
        throw new DbAdminError('"descending" is true or false.', 400, 'bad-request')
      }
      return { column: text(column, 'order.column'), descending: descending === true }
    }),
    filters: filtersOf(body.filters),
  }
}

const FORMATS: ReadonlySet<string> = new Set<ExportFormat>(['csv', 'json', 'sql'])

function formatOf(value: unknown): ExportFormat {
  if (typeof value !== 'string' || !FORMATS.has(value)) {
    throw bad('"format" is csv, json or sql.')
  }
  return value as ExportFormat
}

/** Column names to values: text, and null where `nulls` allows it. */
function values(
  value: unknown,
  field: string,
  nulls: boolean,
  atLeastOne: boolean,
): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`"${field}" maps column names to values.`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if ((atLeastOne && !entries.length) || entries.length > 1_000) {
    throw bad(`"${field}" names 1 to 1000 columns.`)
  }
  for (const [column, v] of entries) {
    if (!column) throw bad(`"${field}" has a column without a name.`)
    if (typeof v !== 'string' && !(nulls && v === null)) {
      throw bad(`"${field}.${column}" is text${nulls ? ' or null' : ''}.`)
    }
  }
  return Object.fromEntries(entries) as Record<string, string | null>
}

/** The grid's staged edits, each checked for the fields its type needs. */
function changesOf(value: unknown): Change[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHANGES) {
    throw bad(`"changes" is a list of 1 to ${MAX_CHANGES} changes.`)
  }
  return value.map((entry: unknown, i): Change => {
    const change = (entry ?? {}) as Record<string, unknown>
    const at = `changes[${i}]`
    if (change.type === 'insert')
      return { type: 'insert', values: values(change.values ?? {}, `${at}.values`, true, false) }
    if (change.type === 'update') {
      return {
        type: 'update',
        key: values(change.key, `${at}.key`, false, true) as Record<string, string>,
        values: values(change.values, `${at}.values`, true, true),
      }
    }
    if (change.type === 'delete') {
      return {
        type: 'delete',
        key: values(change.key, `${at}.key`, false, true) as Record<string, string>,
      }
    }
    throw bad(`"${at}.type" is insert, update or delete.`)
  })
}

function bad(message: string): DbAdminError {
  return new DbAdminError(message, 400, 'bad-request')
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

/** The filter bar's conditions, each with the values its operator takes. */
function filtersOf(value: unknown): Filter[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_FILTERS) {
    throw bad(`"filters" is a list of up to ${MAX_FILTERS} conditions.`)
  }
  return value.map((entry: unknown) => {
    const { column, operator, value: given } = (entry ?? {}) as Record<string, unknown>
    if (typeof operator !== 'string' || !OPERATORS.has(operator)) {
      throw bad(`"${String(operator)}" isn't a filter.`)
    }
    const filter = { column: text(column, 'filters.column'), operator: operator as FilterOperator }
    if (operator === 'is null' || operator === 'is not null') return filter
    if (operator === 'in' || operator === 'not in') {
      if (!strings(given) || !given.length || given.length > MAX_LIST) {
        throw bad(`"${operator}" takes a list of 1 to ${MAX_LIST} values.`)
      }
      return { ...filter, value: given }
    }
    if (operator === 'between' || operator === 'not between') {
      if (!strings(given) || given.length !== 2) throw bad(`"${operator}" takes two values.`)
      return { ...filter, value: given }
    }
    if (typeof given !== 'string') throw bad(`"${operator}" takes one value.`)
    return { ...filter, value: given }
  })
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function failure(error: unknown): Response {
  if (error instanceof QueryError) {
    return reply(error.status, {
      error: {
        code: error.code,
        message: error.message,
        sqlState: error.sqlState,
        ...error.details,
      },
    })
  }
  if (error instanceof DbAdminError) {
    return reply(error.status, { error: { code: error.code, message: error.message } })
  }
  console.error('otw-db: a request failed', error)
  return reply(500, { error: { code: 'internal', message: 'Something went wrong on the server.' } })
}

function logAudit(event: AuditEvent): void {
  console.info(JSON.stringify({ otwDb: event }))
}
