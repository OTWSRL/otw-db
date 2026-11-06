import type {
  Access,
  ApplyResult,
  Capabilities,
  Change,
  ConnectionTag,
  DriverKind,
  ExportFormat,
  Filter,
  QueryResult,
  ResultSet,
  ServerInfo,
  TableDetail,
  TableSummary,
  UiConfig,
} from '@otwdesign/db-core'

export type {
  ApplyResult,
  Change,
  ExportFormat,
  Filter,
  QueryResult,
  ResultSet,
  ServerInfo,
  TableDetail,
  TableSummary,
}

/** A connection as the API lists it: never its URL. */
export interface Connection {
  name: string
  label: string
  tag: ConnectionTag | null
  kind: DriverKind
  access: Access
  /** Null when this server has no driver for its kind yet. */
  capabilities: Capabilities | null
}

/** What the API answered instead of a result. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** For a statement the database refused. */
    readonly sqlState?: string,
    /** Where in the statement, counting characters from 1. */
    readonly position?: number,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The page's settings, which the server put in `<meta name="otw-db">`. */
export function readConfig(doc: Document = document): UiConfig {
  const content = doc.querySelector('meta[name="otw-db"]')?.getAttribute('content')
  // `vite dev` serves the page as it is, placeholder and all.
  if (!content || content.startsWith('%')) return { api: '/api' }
  return JSON.parse(content) as UiConfig
}

export interface RowsQuery {
  connection: string
  schema: string
  table: string
  limit: number
  offset: number
  order?: { column: string; descending?: boolean }[]
  filters?: Filter[]
}

/** The API, with the header every call needs and its errors as ApiError. */
export function createApi(config: UiConfig, onUnauthorized: () => void) {
  function send(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${config.api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-db-admin': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  }

  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await send(path, body, signal)
    if (!response.ok) throw await failure(response)
    return (await response.json()) as T
  }

  async function failure(response: Response): Promise<ApiError> {
    const answer = (await response.json().catch(() => ({}))) as {
      error?: {
        code: string
        message: string
        sqlState?: string
        position?: number
        detail?: string
        hint?: string
      }
    }
    if (response.status === 401) onUnauthorized()
    const e = answer.error
    return new ApiError(
      response.status,
      e?.code ?? 'failed',
      e?.message ?? `The server answered ${response.status}.`,
      e?.sqlState,
      e?.position,
      e?.detail,
      e?.hint,
    )
  }
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

  return {
    connections: () =>
      call<{ connections: Connection[] }>('/connections').then((r) => r.connections),
    info: (connection: string) =>
      call<{ info: ServerInfo }>(`/info?${q({ connection })}`).then((r) => r.info),
    tables: (connection: string) =>
      call<{ tables: TableSummary[] }>(`/tables?${q({ connection })}`).then((r) => r.tables),
    table: (connection: string, schema: string, name: string) =>
      call<{ table: TableDetail }>(`/table?${q({ connection, schema, name })}`).then(
        (r) => r.table,
      ),
    rows: (request: RowsQuery, signal?: AbortSignal) => call<ResultSet>('/rows', request, signal),
    count: (request: Omit<RowsQuery, 'limit' | 'offset' | 'order'>, signal?: AbortSignal) =>
      call<{ count: number }>('/count', request, signal).then((r) => r.count),
    query: (connection: string, sql: string, queryId: string, signal?: AbortSignal) =>
      call<QueryResult>('/query', { connection, sql, queryId }, signal),
    apply: (request: {
      connection: string
      schema: string
      table: string
      changes: Change[]
      dryRun?: boolean
    }) => call<ApplyResult>('/apply', request),
    /** A table (filtered and in order) as a file, with the name the server gave it. */
    exportTable: async (
      request: Omit<RowsQuery, 'limit' | 'offset'> & { format: ExportFormat },
    ): Promise<{ blob: Blob; filename: string }> => {
      const response = await send('/export', request)
      if (!response.ok) throw await failure(response)
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${request.table}.${request.format}`
      return { blob: await response.blob(), filename }
    },
    cancel: (queryId: string) =>
      call<{ canceled: boolean }>('/cancel', { queryId }).then((r) => r.canceled),
  }
}

export type Api = ReturnType<typeof createApi>
