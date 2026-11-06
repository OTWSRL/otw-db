import { driverKind } from './connections.ts'
import { openDriver } from './drivers/index.ts'
import { DbAdminError, QueryError } from './errors.ts'
import type {
  Access,
  AuditEvent,
  ConnectionConfig,
  Driver,
  Filter,
  FilterOperator,
  Limits,
  RowsRequest,
  Viewer,
} from './types.ts'
import { renderAsset, renderIndex, type UiAssets } from './ui.ts'

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

export interface DbAdmin {
  readonly basePath: string
  /** A standard Fetch handler: Next.js route handlers, Hono, Bun and Deno take it as it is. */
  fetch(request: Request): Promise<Response>
  /** The same endpoints, flat: no path has more than its fixed segments. */
  readonly routes: readonly DbAdminRoute[]
  /** Closes every connection it opened. */
  close(): Promise<void>
}

export const DEFAULT_LIMITS: Limits = { maxRows: 1_000, timeoutMs: 30_000 }
const MAX_PAGE = 1_000
const MAX_BODY = 1_048_576
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const QUERY_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_FILTERS = 20
const MAX_LIST = 1_000
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
  const running = new Map<string, { viewer: string; controller: AbortController }>()
  const open = options.driver ?? openDriver
  const loadUi = options.ui === false ? undefined : (options.ui ?? defaultUi)
  let ui: Promise<UiAssets> | undefined

  function driver(connection: ConnectionConfig): Driver {
    let found = drivers.get(connection.name)
    if (!found) {
      found = open(connection)
      drivers.set(connection.name, found)
    }
    return found
  }

  /** The connection by name, with this viewer's access to it; unknown and hidden look the same. */
  function reach(viewer: Viewer, name: unknown): { connection: ConnectionConfig; access: Access } {
    const connection = typeof name === 'string' ? connections.get(name) : undefined
    const access = connection ? accessOf(viewer, connection) : null
    if (!connection || !access) {
      throw new DbAdminError(`There's no connection "${String(name)}".`, 404, 'unknown-connection')
    }
    return { connection, access }
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
            capabilities = driver(connection).capabilities
          } catch (error) {
            if (!(error instanceof DbAdminError)) throw error
          }
          const label = connection.label ?? connection.name
          const tag = connection.tag ?? null
          return [{ name: connection.name, label, tag, kind, access, capabilities }]
        })
        return { connections: visible }
      },
    },
    {
      method: 'GET',
      path: '/api/tables',
      async run(request, viewer) {
        const { connection } = reach(viewer, new URL(request.url).searchParams.get('connection'))
        return { tables: await driver(connection).tables() }
      },
    },
    {
      method: 'GET',
      path: '/api/table',
      async run(request, viewer) {
        const params = new URL(request.url).searchParams
        const { connection } = reach(viewer, params.get('connection'))
        const table = await driver(connection).table(
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
        const { connection } = reach(viewer, new URL(request.url).searchParams.get('connection'))
        return { info: await driver(connection).info() }
      },
    },
    {
      method: 'POST',
      path: '/api/count',
      async run(request, viewer) {
        const body = await json(request)
        const { connection } = reach(viewer, body.connection)
        const target = {
          schema: text(body.schema, 'schema'),
          table: text(body.table, 'table'),
          filters: filtersOf(body.filters),
        }
        const started = performance.now()
        const statement = `count ${target.schema}.${target.table}`
        try {
          const rows = await driver(connection).count(target, {
            timeoutMs: limits.timeoutMs,
            signal: request.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
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
        const { connection } = reach(viewer, body.connection)
        const page = rowsRequest(body)
        const started = performance.now()
        const statement = `${page.schema}.${page.table}`
        try {
          const result = await driver(connection).rows(page, {
            timeoutMs: limits.timeoutMs,
            signal: request.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
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
        const { connection, access } = reach(viewer, body.connection)
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
          const result = await driver(connection).query(sql, {
            access,
            maxRows,
            timeoutMs: limits.timeoutMs,
            signal: controller.signal,
          })
          await record({
            viewer: viewer.id,
            connection: connection.name,
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
  const routes = [...pages, ...api]

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
      return reply(200, await run(viewer))
    } catch (error) {
      return failure(error)
    }
  }

  return {
    basePath,
    routes,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const within = pathname === basePath || pathname.startsWith(`${basePath}/`)
      const path = within ? pathname.slice(basePath.length) || '/' : null
      const matches = path === null ? [] : routes.filter((route) => pathMatches(route.path, path))
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
      const open = [...drivers.values()]
      drivers.clear()
      await Promise.all(open.map((d) => d.close()))
    },
  }
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
