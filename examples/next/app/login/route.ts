import { SESSION } from '../../db-admin'

/** Stands in for the app's sign-in: /login?secret=… sets the session cookie, then opens /db. */
export function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get('secret')
  if (!secret || secret !== process.env.DEMO_SECRET) {
    return new Response('Sign in with /login?secret=…', { status: 401 })
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: '/db',
      'set-cookie': `${SESSION}=${secret}; HttpOnly; SameSite=Lax; Path=/`,
    },
  })
}
