import { useEffect, useMemo, useState } from 'react'
import { addressOf, readAddress, storageScope, type Address } from './address.ts'
import { createApi, type ApiError, type Connection } from './api.ts'
import { ConnectionList } from './ConnectionList.tsx'
import { Workspace } from './workspace/Workspace.tsx'
import type { UiConfig } from '@otwdesign/db-core'

export function App({ config }: { config: UiConfig }) {
  const [signedOut, setSignedOut] = useState(false)
  const api = useMemo(() => createApi(config, () => setSignedOut(true)), [config])
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [open, setOpen] = useState(() => readAddress(location.hash))

  useEffect(() => {
    api.connections().then(setConnections, (e: unknown) => setError(e as ApiError))
  }, [api])

  useEffect(() => {
    const follow = () => setOpen(readAddress(location.hash))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])

  const go = (address: Address) => {
    location.hash = addressOf(address)
    setOpen(address)
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

  const connection = connections.find((c) => c.name === open.connection && c.capabilities)
  if (connection) {
    // Another database only where the connection opens others; else its own.
    const database = connection.capabilities?.databases ? open.database : null
    return (
      <Workspace
        key={storageScope(connection.name, database)}
        api={api}
        connection={connection}
        database={database}
        onDatabase={(name) => go({ connection: connection.name, database: name })}
        onSwitch={() => go({ connection: '', database: null })}
      />
    )
  }
  return (
    <ConnectionList
      connections={connections}
      onOpen={(c) => go({ connection: c.name, database: null })}
    />
  )
}
