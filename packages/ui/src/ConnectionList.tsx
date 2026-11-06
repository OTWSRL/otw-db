import { useState } from 'react'
import type { Connection } from './api.ts'
import { Icon } from './ui/icons.tsx'

const KIND_BADGE: Record<string, string> = { postgres: 'Pg', mysql: 'My', sqlite: 'Lt' }
const KIND_NAME: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
}

/** The welcome window: every connection, its environment as a color, opened with a click. */
export function ConnectionList({
  connections,
  onOpen,
}: {
  connections: readonly Connection[]
  onOpen(connection: Connection): void
}) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = connections.filter(
    (c) =>
      !needle ||
      c.label.toLowerCase().includes(needle) ||
      c.name.includes(needle) ||
      c.tag?.includes(needle),
  )

  return (
    <div className="connections">
      <div className="connections-card">
        <div className="connections-head">
          <Icon name="database" size={28} />
          <div>
            <h1>OTW DB</h1>
            <p>{connections.length === 1 ? '1 connection' : `${connections.length} connections`}</p>
          </div>
        </div>
        {connections.length > 6 && (
          <div className="connections-search">
            <input
              className="input"
              type="search"
              aria-label="Search connections"
              placeholder="Search for connection…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <ul className="connections-list" aria-label="Connections">
          {!connections.length && (
            <li className="tree-empty">
              No connections yet. Set <code>DB_ADMIN_&lt;NAME&gt;_URL</code> on the server.
            </li>
          )}
          {shown.map((connection, i) => {
            const supported = connection.capabilities !== null
            const tag = connection.tag ? `tag-${connection.tag}` : ''
            return (
              <li key={connection.name} className={tag}>
                <button
                  type="button"
                  className="connection"
                  aria-label={connection.label}
                  aria-describedby={`connection-${connection.name}`}
                  aria-disabled={!supported}
                  autoFocus={i === 0 && connections.length <= 6}
                  onClick={() => supported && onOpen(connection)}
                >
                  <span className="kind-badge">{KIND_BADGE[connection.kind] ?? '?'}</span>
                  <span>
                    <div className="connection-name">{connection.label}</div>
                    <div className="connection-meta" id={`connection-${connection.name}`}>
                      {KIND_NAME[connection.kind]}
                      {connection.label !== connection.name && ` · ${connection.name}`}
                      {!supported && ' · not supported yet'}
                    </div>
                  </span>
                  <span className="connection-tags">
                    {connection.access === 'read' && (
                      <Icon name="lock" size={13} label="Read-only" />
                    )}
                    {connection.tag && <span className="pill">{connection.tag}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
