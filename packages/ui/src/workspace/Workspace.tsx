import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { storageScope } from '../address.ts'
import type { Api, ApiError, Connection, ServerInfo, TableSummary } from '../api.ts'
import { loadHistory } from '../history.ts'
import { loadTabs, saveTabs, tabsReducer } from '../tabs.ts'
import { Icon } from '../ui/icons.tsx'
import {
  WorkspaceContext,
  type LogEntry,
  type ShownRow,
  type Workspace as WorkspaceValue,
} from './context.ts'
import { BackupDialog } from './BackupDialog.tsx'
import { DatabasePicker } from './DatabasePicker.tsx'
import { ConsolePanel, RowPanel, TabBar, ToolButton } from './Panels.tsx'
import { QueryTab } from './QueryTab.tsx'
import { QuickOpen } from './QuickOpen.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TableTab } from './TableTab.tsx'

/** The schema to show first: the connection's database, then public, then the first there is. */
export function firstSchema(tables: readonly TableSummary[], database: string): string {
  const schemas = new Set(tables.map((t) => t.schema))
  if (database && schemas.has(database)) return database
  if (schemas.has('public')) return 'public'
  return tables[0]?.schema ?? 'public'
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = MAC ? '⌘' : 'Ctrl+'

interface Props {
  api: Api
  connection: Connection
  /** One of the server's other databases; null for the connection's own. */
  database: string | null
  /** Opens another database of the server (null: the connection's own) in the workspace's place. */
  onDatabase(database: string | null): void
  onSwitch(): void
}

/** A connection's window, on one of its databases: toolbar, sidebar, tabs, row panel and console. */
export function Workspace({
  api: connectionApi,
  connection,
  database,
  onDatabase,
  onSwitch,
}: Props) {
  const api = useMemo(() => connectionApi.forDatabase(database), [connectionApi, database])
  const scope = storageScope(connection.name, database)
  const others = connection.capabilities?.databases === true
  const backups = connection.capabilities?.backup === true
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [tables, setTables] = useState<TableSummary[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  const [tabs, dispatch] = useReducer(tabsReducer, scope, loadTabs)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [row, setRow] = useState<ShownRow | null>(null)
  const [sidebar, setSidebar] = useState(true)
  const [panel, setPanel] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filterKey, setFilterKey] = useState(0)
  const [history, setHistory] = useState(() => loadHistory(scope))

  useEffect(() => {
    saveTabs(scope, tabs)
  }, [scope, tabs])

  useEffect(() => {
    let current = true
    Promise.all([api.info(connection.name), api.tables(connection.name)]).then(
      ([i, t]) => {
        if (!current) return
        setInfo(i)
        setTables(t)
        setError(null)
        // The database connected to (MySQL), else public, where psql's search path starts.
        setSchema((s) => s ?? firstSchema(t, i.database))
      },
      (e: unknown) => current && setError(e as ApiError),
    )
    return () => {
      current = false
    }
  }, [api, connection.name, refreshKey])

  const log = useCallback(
    (entry: Omit<LogEntry, 'at'>) =>
      setEntries((list) => [...list.slice(-499), { at: new Date(), ...entry }]),
    [],
  )
  const activeTab = tabs.tabs.find((t) => t.id === tabs.active) ?? null

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const mod = MAC ? event.metaKey : event.ctrlKey
      const key = event.key.toLowerCase()
      const handled = (() => {
        if (mod && key === 'e') dispatch({ type: 'new-query' })
        else if (mod && key === 'p') setQuickOpen(true)
        else if (mod && key === 'k' && others) setPicking(true)
        else if (mod && !event.shiftKey && key === 'r') setRefreshKey((n) => n + 1)
        else if (mod && key === 'f' && activeTab?.kind === 'table') setFilterKey((n) => n + 1)
        // ⌘W closes the browser's tab whatever a page does, so ⌥W closes ours.
        else if (event.altKey && event.code === 'KeyW' && activeTab)
          dispatch({ type: 'close', id: activeTab.id })
        else if (mod && event.key === '[') dispatch({ type: 'cycle', by: -1 })
        else if (mod && event.key === ']') dispatch({ type: 'cycle', by: 1 })
        else return false
        return true
      })()
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, others])

  const value = useMemo<WorkspaceValue>(
    () => ({ api, connection, scope, log, showRow: setRow, refreshKey, filterKey }),
    [api, connection, scope, log, refreshKey, filterKey],
  )
  const summaries = useMemo(
    () => new Map((tables ?? []).map((t) => [`${t.schema}.${t.name}`, t])),
    [tables],
  )
  const kinds = useMemo(() => new Map([...summaries].map(([k, t]) => [k, t.kind])), [summaries])
  const namespace = useMemo(() => {
    const ns: Record<string, Record<string, string[]>> = {}
    for (const t of tables ?? []) (ns[t.schema] ??= {})[t.name] = []
    return ns
  }, [tables])
  const tag = connection.tag ? `tag-${connection.tag}` : ''
  const current =
    activeTab?.kind === 'table' ? { schema: activeTab.schema, table: activeTab.table } : null
  // The database asked for until the server names it, which it does even when it can't open it.
  const shownDatabase = info?.database ?? database

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="workspace">
        <header className="toolbar">
          <div className="toolbar-group">
            <ToolButton
              icon="sidebar"
              label="Sidebar"
              pressed={sidebar}
              onClick={() => setSidebar((s) => !s)}
            />
            <ToolButton icon="switch" label="Connections" onClick={onSwitch} />
            <ToolButton
              icon="refresh"
              label="Refresh"
              shortcut={`${MOD}R`}
              onClick={() => setRefreshKey((n) => n + 1)}
            />
          </div>
          <div
            className={`status-pill ${tag}`}
            aria-label="Connection"
            title={connection.warning ?? undefined}
          >
            {connection.tag && <span className={`tag-dot ${tag}`} title={connection.tag} />}
            <strong>{info ? `${info.product} ${info.version}` : '…'}</strong>
            <span className="sep">:</span>
            <span>{connection.label}</span>
            <span className="sep">:</span>
            {others ? (
              <button
                type="button"
                className="database-button"
                aria-haspopup="dialog"
                title={`Open another database (${MOD}K)`}
                onClick={() => setPicking(true)}
              >
                {shownDatabase ?? '…'}
                <Icon name="down" size={11} />
              </button>
            ) : (
              <span>{shownDatabase ?? '…'}</span>
            )}
            {connection.access === 'read' && (
              <span className="read-only" title="Read-only: writes are refused">
                <Icon name="lock" size={12} /> read-only
              </span>
            )}
          </div>
          <div className="toolbar-group end">
            {backups && (
              <ToolButton
                icon="backup"
                label="Back up and restore"
                onClick={() => setBackingUp(true)}
              />
            )}
            <ToolButton
              icon="sql"
              label="New SQL editor"
              shortcut={`${MOD}E`}
              onClick={() => dispatch({ type: 'new-query' })}
            />
            <ToolButton
              icon="console"
              label="Console"
              pressed={consoleOpen}
              onClick={() => setConsoleOpen((c) => !c)}
            />
            <ToolButton
              icon="panel"
              label="Row panel"
              pressed={panel}
              onClick={() => setPanel((p) => !p)}
            />
          </div>
        </header>
        <div className={`body${sidebar ? '' : ' no-sidebar'}${panel ? ' with-panel' : ''}`}>
          {sidebar ? (
            <Sidebar
              tables={tables}
              schema={schema ?? 'public'}
              onSchema={setSchema}
              current={current}
              onOpen={(t) => dispatch({ type: 'open-table', schema: t.schema, table: t.name })}
              history={history}
              onHistory={(sql) => dispatch({ type: 'new-query', sql })}
            />
          ) : (
            <div />
          )}
          <main className="content">
            <TabBar
              tabs={tabs.tabs}
              active={tabs.active}
              kinds={kinds}
              onActivate={(id) => dispatch({ type: 'activate', id })}
              onClose={(id) => dispatch({ type: 'close', id })}
            />
            {error && (
              <div className="notice" role="alert">
                {error.message}
              </div>
            )}
            {!tabs.tabs.length && (
              <div className="empty">
                <div>Open a table from the sidebar, or</div>
                <div>
                  Open anything <kbd>{MOD}P</kbd> · New SQL editor <kbd>{MOD}E</kbd>
                  {others && (
                    <>
                      {' '}
                      · Open database <kbd>{MOD}K</kbd>
                    </>
                  )}
                </div>
              </div>
            )}
            {tabs.tabs.map((tab) =>
              tab.kind === 'table' ? (
                <TableTab
                  key={tab.id}
                  schema={tab.schema}
                  table={tab.table}
                  summary={summaries.get(`${tab.schema}.${tab.table}`)}
                  active={tab.id === tabs.active}
                />
              ) : (
                <QueryTab
                  key={tab.id}
                  id={tab.id}
                  sql={tab.sql}
                  onChange={(sql) => dispatch({ type: 'edit-sql', id: tab.id, sql })}
                  schema={namespace}
                  defaultSchema={schema ?? 'public'}
                  kind={connection.kind}
                  active={tab.id === tabs.active}
                  onHistory={() => setHistory(loadHistory(scope))}
                />
              ),
            )}
            {consoleOpen && <ConsolePanel entries={entries} />}
          </main>
          {panel ? <RowPanel row={row} /> : <div />}
        </div>
      </div>
      {picking && (
        <DatabasePicker
          api={api}
          connection={connection.name}
          open={info?.database ?? database}
          onClose={() => setPicking(false)}
          onOpen={(name) => {
            setPicking(false)
            if (name !== database) onDatabase(name)
          }}
        />
      )}
      {backingUp && (
        <BackupDialog
          api={api}
          connection={connection}
          onClose={() => setBackingUp(false)}
          onRestored={() => setRefreshKey((n) => n + 1)}
        />
      )}
      {quickOpen && tables && (
        <QuickOpen
          tables={tables}
          onClose={() => setQuickOpen(false)}
          onOpen={(t) => {
            setQuickOpen(false)
            dispatch({ type: 'open-table', schema: t.schema, table: t.name })
          }}
        />
      )}
    </WorkspaceContext.Provider>
  )
}
