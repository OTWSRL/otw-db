/** The browser app's files, as `@otwdesign/db-ui` builds them. */
export interface UiAssets {
  /** The page, with `%OTW_DB_CONFIG%` where its settings go and `%OTW_DB_BASE%` before each file. */
  index: string
  /** Files under `assets/`, by name; their names change with their content. */
  files: Readonly<Record<string, { type: string; body: string }>>
}

/** What the page needs from the server, read from its `<meta name="otw-db">`. */
export interface UiConfig {
  /** Where the API is, such as `/db/api`. */
  api: string
  /** Where to send a browser the API turned away (401), if the host has a sign-in page. */
  signInUrl?: string
}

/**
 * Scripts only from here, as files; styles may be inline (the grid positions rows with them, the
 * editor adds its own). No frames from elsewhere, no forms or links to elsewhere.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** The page, its settings filled in. */
export function renderIndex(assets: UiAssets, basePath: string, config: UiConfig): Response {
  const html = assets.index
    .replaceAll('%OTW_DB_CONFIG%', escapeAttribute(JSON.stringify(config)))
    .replaceAll('%OTW_DB_BASE%', escapeAttribute(basePath))
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    },
  })
}

/** One of the app's files. Its name changes with its content, so browsers keep it a year. */
export function renderAsset(assets: UiAssets, name: string): Response {
  const file = Object.hasOwn(assets.files, name) ? assets.files[name] : undefined
  if (!file) return new Response('Not found', { status: 404 })
  return new Response(file.body, {
    headers: {
      'content-type': file.type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  })
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
