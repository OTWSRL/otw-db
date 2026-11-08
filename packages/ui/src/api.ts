import type {
  Access,
  ApplyResult,
  BackupHeader,
  BackupOptions,
  Capabilities,
  Change,
  ConnectionTag,
  DatabaseList,
  DriverKind,
  ExportFormat,
  Filter,
  QueryResult,
  RestorePlan,
  RestoreResult,
  ResultSet,
  ServerInfo,
  TableDetail,
  TableSummary,
  UiConfig,
} from '@otwdesign/db-core'

export type {
  ApplyResult,
  BackupHeader,
  BackupOptions,
  RestorePlan,
  RestoreResult,
  Change,
  DatabaseList,
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
  /** Shown wherever people run SQL on it. */
  warning: string | null
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

/** A line the restore sends as it goes. */
export type RestoreLine =
  | { type: 'progress'; statements: number; bytes: number }
  | ({ type: 'done'; durationMs: number } & RestoreResult)
  | { type: 'error'; error: { code: string; message: string } }

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

/**
 * The API, with the header every call needs and its errors as ApiError. With `database`, every
 * call that reads or runs something does so on that database of the connection's server.
 */
export function createApi(config: UiConfig, onUnauthorized: () => void, database?: string) {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

  /** `path` and `body` naming the database, when there is one. */
  function at(path: string, body?: unknown): [string, unknown] {
    if (!database) return [path, body]
    if (body !== undefined) return [path, { ...(body as object), database }]
    return [`${path}${path.includes('?') ? '&' : '?'}${q({ database })}`, body]
  }

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
  /** A call on the database this API is for. */
  function on<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const [where, sent] = at(path, body)
    return call<T>(where, sent, signal)
  }

  return {
    /** The same API on another of the connection's server's databases; null for its own. */
    forDatabase: (name: string | null) => createApi(config, onUnauthorized, name ?? undefined),
    connections: () =>
      call<{ connections: Connection[] }>('/connections').then((r) => r.connections),
    /** The server's databases the connection's login may open, from the connection's own. */
    databases: (connection: string) => call<DatabaseList>(`/databases?${q({ connection })}`),
    info: (connection: string) =>
      on<{ info: ServerInfo }>(`/info?${q({ connection })}`).then((r) => r.info),
    tables: (connection: string) =>
      on<{ tables: TableSummary[] }>(`/tables?${q({ connection })}`).then((r) => r.tables),
    table: (connection: string, schema: string, name: string) =>
      on<{ table: TableDetail }>(`/table?${q({ connection, schema, name })}`).then((r) => r.table),
    rows: (request: RowsQuery, signal?: AbortSignal) => on<ResultSet>('/rows', request, signal),
    count: (request: Omit<RowsQuery, 'limit' | 'offset' | 'order'>, signal?: AbortSignal) =>
      on<{ count: number }>('/count', request, signal).then((r) => r.count),
    query: (connection: string, sql: string, queryId: string, signal?: AbortSignal) =>
      on<QueryResult>('/query', { connection, sql, queryId }, signal),
    apply: (request: {
      connection: string
      schema: string
      table: string
      changes: Change[]
      dryRun?: boolean
    }) => on<ApplyResult>('/apply', request),
    /** A table (filtered and in order) as a file, with the name the server gave it. */
    exportTable: async (
      request: Omit<RowsQuery, 'limit' | 'offset'> & { format: ExportFormat },
    ): Promise<{ blob: Blob; filename: string }> => {
      const response = await send(...at('/export', request))
      if (!response.ok) throw await failure(response)
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${request.table}.${request.format}`
      return { blob: await response.blob(), filename }
    },
    cancel: (queryId: string) =>
      call<{ canceled: boolean }>('/cancel', { queryId }).then((r) => r.canceled),
    /** What a backup of the database would hold, and whether it can be restored here. */
    backupOptions: (connection: string) =>
      on<BackupOptions>(`/backup-options?${q({ connection })}`),
    /** The backup as a file, with the name the server gave it. */
    backup: async (request: {
      connection: string
      schemas: string[]
      format: 'sql' | 'pg_dump'
    }): Promise<{ blob: Blob; filename: string }> => {
      const response = await send(...at('/backup', request))
      if (!response.ok) throw await failure(response)
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'backup'
      return { blob: await response.blob(), filename }
    },
    restorePlan: (connection: string, header: BackupHeader) =>
      on<RestorePlan>('/restore-plan', { connection, header }),
    /**
     * Uploads `file` a piece at a time (a host may take 4.5 MB a request at most), then runs the
     * restore, telling `onLine` how it goes. Resolves with the restore's last line.
     */
    restore: async (
      connection: string,
      file: Blob & { name?: string },
      kind: 'sql' | 'pg_dump',
      onUpload: (sent: number) => void,
      onLine: (line: RestoreLine) => void,
    ): Promise<RestoreLine> => {
      const { upload, chunkBytes } = await on<{ upload: string; chunkBytes: number }>(
        '/restore-start',
        { connection, size: file.size, kind, name: file.name ?? 'backup' },
      )
      try {
        for (let seq = 0, sent = 0; sent < file.size; seq += 1) {
          const piece = file.slice(sent, sent + chunkBytes)
          const [path] = at(`/restore-chunk?${q({ connection, upload, seq: String(seq) })}`)
          await retried(async () => {
            const response = await fetch(`${config.api}${path}`, {
              method: 'POST',
              headers: { 'x-db-admin': '1', 'content-type': 'application/octet-stream' },
              body: piece,
              credentials: 'same-origin',
            })
            if (!response.ok) throw await failure(response)
          })
          sent += piece.size
          onUpload(sent)
        }
      } catch (error) {
        await on('/restore-discard', { connection, upload }).catch(() => {})
        throw error
      }
      const response = await send(...at('/restore-run', { connection, upload }))
      if (!response.ok) throw await failure(response)
      let last: RestoreLine | null = null
      for await (const line of ndjson(response)) {
        last = line as RestoreLine
        onLine(last)
      }
      if (!last)
        throw new ApiError(500, 'failed', 'The restore stopped without saying how it went.')
      return last
    },
  }
}

/** Tries `work` again, twice, after a network failure or a server error: an upload goes on. */
async function retried(work: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      const again = !(error instanceof ApiError) || error.status >= 500
      if (!again || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

/** A response's lines of JSON, each as it arrives. */
async function* ndjson(response: Response): AsyncGenerator<unknown> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += value
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) yield JSON.parse(line)
    }
    if (done) break
  }
  if (buffer.trim()) yield JSON.parse(buffer)
}

export type Api = ReturnType<typeof createApi>
