/**
 * The patterns a host registers the handler under, relative to its base path, for routers that
 * register routes one by one (the OTW CMS's). Four, each with at most one parameter, so a router
 * that matches every route in turn barely notices them; the handler tells the endpoints apart.
 * Nothing here imports anything: a host can register them at boot and load the handler on the
 * first request.
 */
export const ROUTES = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/assets/:file' },
  { method: 'GET', path: '/api/:endpoint' },
  { method: 'POST', path: '/api/:endpoint' },
] as const satisfies readonly { method: 'GET' | 'POST'; path: string }[]
