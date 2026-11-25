import { MIN_PASSWORD } from './session.ts'

/*
 * The sign-in page: one small page of this package's own, with no script, so the browser app
 * needs no change to offer it. Its Content-Security-Policy lets it do nothing but post its form
 * back to where it came from.
 */

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; background: Canvas; color: CanvasText; }
  main { width: min(360px, calc(100vw - 48px)); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  p { margin: 0 0 12px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 6px;
    background: Field; color: FieldText; }
  button, a.button { display: inline-block; margin-top: 12px; padding: 8px 14px; font: inherit; font-weight: 600;
    border: 0; border-radius: 6px; background: #2f6fed; color: #fff; cursor: pointer; text-decoration: none; }
  button.plain { background: transparent; color: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  .notice { padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, #d92d20 14%, transparent); }
  .muted { opacity: 0.75; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  form.row { display: inline; }
`

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

function page(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in · OTW DB</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        ...headers,
      },
    },
  )
}

/** What the sign-in page has to say, besides its form. */
export interface SignInState {
  basePath: string
  /** A password is set, and long enough to be taken. */
  password: 'ready' | 'unset' | 'short'
  /** The app has listed users (DB_ADMIN_USERS), who need no password. */
  listed: boolean
  /** The visitor's sign-in to the app has run out: the app renews it, not this page. */
  expired?: boolean
  /** The password just tried was wrong. */
  wrong?: boolean
}

/** The page that asks for the password, or says why there is none to ask for. */
export function signInPage(state: SignInState, status = 200): Response {
  const action = escape(`${state.basePath}/sign-in`)
  const parts = ['<h1>Sign in to the database</h1>']
  if (state.wrong) {
    parts.push('<p class="notice" role="alert">That isn’t the password.</p>')
  }
  if (state.password === 'ready') {
    parts.push(
      `<form method="post" action="${action}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form>`,
    )
  } else if (!state.listed) {
    parts.push(
      state.password === 'unset'
        ? '<p class="notice" role="alert">No password is set. Set <code>DB_ADMIN_PASSWORD</code> in this app’s environment, then open this page again.</p>'
        : `<p class="notice" role="alert"><code>DB_ADMIN_PASSWORD</code> is too short to be safe: it needs ${MIN_PASSWORD} characters or more.</p>`,
    )
  }
  if (state.listed) {
    parts.push(
      state.expired
        ? '<p class="notice" role="alert">Your sign-in to the app has run out. Open the app, then come back to this page.</p>'
        : `<p class="muted">${state.password === 'ready' ? 'Or sign' : 'Sign'} in to the app as one of the users it lets in here, then open this page again: they need no password.</p>`,
    )
  }
  return page(status, parts.join(''))
}

/** The page for someone already in: on to the database, or out again. */
export function signedInPage(basePath: string, who: string | null): Response {
  const home = escape(basePath || '/')
  const out = escape(`${basePath}/sign-out`)
  return page(
    200,
    who
      ? `<h1>You’re signed in</h1><p>As ${escape(who)}, one of the app’s users let in here. To sign out, sign out of the app.</p><a class="button" href="${home}">Open the database</a>`
      : `<h1>You’re signed in</h1><a class="button" href="${home}">Open the database</a> <form class="row" method="post" action="${out}"><button class="plain" type="submit">Sign out</button></form>`,
  )
}

/** Sends the browser on, with a cookie set or cleared on the way. */
export function redirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) },
  })
}
