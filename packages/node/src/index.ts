import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { DbAdmin } from '@otwdesign/db-core'

/** Express's and Connect's `next`: called for paths outside the base path, and with errors. */
export type Next = (error?: unknown) => void

/** A node:http-style handler, as Express, Connect and `http.createServer` take. It resolves once the response is sent. */
export type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: Next,
) => Promise<void>

/**
 * The Fetch handler for node:http servers. Paths outside the admin's base path go to `next`
 * when there is one (Express, Connect), and get a 404 otherwise. A body a body-parser already
 * read (`express.json()`) is passed on as it parsed it.
 */
export function toNodeHandler(admin: Pick<DbAdmin, 'fetch' | 'basePath'>): NodeHandler {
  return async (req, res, next) => {
    try {
      // Express strips its mount path from `url` and keeps the whole one in `originalUrl`.
      const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/'
      if (!within(path, admin.basePath)) {
        if (next) return next()
        res.statusCode = 404
        res.end()
        return
      }
      await send(res, await admin.fetch(toRequest(req, res, path)))
    } catch (error) {
      // The browser went away mid-response: nothing left to tell it.
      if (res.destroyed) return
      if (next) return next(error)
      console.error('otw-db: a request failed', error)
      if (res.headersSent) res.destroy(error as Error)
      else {
        res.statusCode = 500
        res.end()
      }
    }
  }
}

function within(path: string, basePath: string): boolean {
  if (!basePath) return true
  const pathname = path.split('?', 1)[0]!
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

/** A Fetch Request for the Node one: its URL, headers and body, aborted if the browser leaves. */
export function toRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path = req.url ?? '/',
): Request {
  const protocol = (req.socket as TLSSocket).encrypted ? 'https' : 'http'
  const url = new URL(path, `${protocol}://${req.headers.host ?? 'localhost'}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) controller.abort()
  })
  const method = req.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal }
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.readableEnded) {
      // Read already, by a body parser: what it parsed is all there is.
      const parsed = (req as IncomingMessage & { body?: unknown }).body
      headers.delete('content-length')
      if (parsed !== undefined) {
        init.body =
          typeof parsed === 'string' || parsed instanceof Uint8Array
            ? (parsed as BodyInit)
            : JSON.stringify(parsed)
      }
    } else {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
      init.duplex = 'half'
    }
  }
  return new Request(url, init)
}

/** Writes a Fetch Response to a Node one, streaming its body. */
export async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') res.setHeader(name, value)
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length) res.setHeader('set-cookie', cookies)
  if (!response.body) {
    res.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res)
}
