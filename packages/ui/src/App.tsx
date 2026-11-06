import { useEffect, useMemo, useState } from 'react'
import { createApi, type ApiError, type Connection } from './api.ts'
import { ConnectionList } from './ConnectionList.tsx'
import { Workspace } from './workspace/Workspace.tsx'
import type { UiConfig } from '@otwdesign/db-core'

/** The open connection's name, kept in the address (`#main`) so a reload comes back to it. */
const fromHash = () => decodeURIComponent(location.hash.slice(1))

export function App({ config }: { config: UiConfig }) {
  const [signedOut, setSignedOut] = useState(false)
  const api = useMemo(() => createApi(config, () => setSignedOut(true)), [config])
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [open, setOpen] = useState(fromHash)

  useEffect(() => {
    api.connections().then(setConnections, (e: unknown) => setError(e as ApiError))
  }, [api])

  useEffect(() => {
    const follow = () => setOpen(fromHash())
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const choose = (name: string) => {
    location.hash = name ? encodeURIComponent(name) : ''
    setOpen(name)
  }

  if (signedOut) {
    return (
      <div className="signed-out">
        <h1>Sign in to continue</h1>
        {config.signInUrl ? (
          <a href={config.signInUrl}>Sign in</a>
        ) : (
          <p>Open the link this server gave you, or sign in to the app it's part of.</p>
        )}
      </div>
    )
  }
  if (error) {
    return (
      <div className="signed-out">
        <h1>Can't reach the server</h1>
        <p>{error.message}</p>
      </div>
    )
  }
  if (!connections) return <div className="signed-out">Loading…</div>

  const connection = connections.find((c) => c.name === open && c.capabilities)
  if (connection) {
    return (
      <Workspace
        key={connection.name}
        api={api}
        connection={connection}
        onSwitch={() => choose('')}
      />
    )
  }
  return <ConnectionList connections={connections} onOpen={(c) => choose(c.name)} />
}
