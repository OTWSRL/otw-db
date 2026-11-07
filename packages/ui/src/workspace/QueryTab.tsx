import type { SQLNamespace } from '@codemirror/lang-sql'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ApiError, type QueryResult } from '../api.ts'
import { remember } from '../history.ts'
import { looksLikeWrite, splitStatements, statementAt, type Statement } from '../sql.ts'
import { toCsv, toJson } from '@otwdesign/db-core/format'
import { ConfirmDialog } from '../ui/Dialog.tsx'
import { download, ExportMenu } from '../ui/ExportMenu.tsx'
import { Icon } from '../ui/icons.tsx'
import { useWorkspace } from './context.ts'
import { DataGrid, type Cell } from './DataGrid.tsx'
import { Editor } from './Editor.tsx'

interface Outcome {
  statement: Statement
  result?: QueryResult
  error?: ApiError
}

interface Props {
  id: string
  sql: string
  onChange(sql: string): void
  schema: SQLNamespace
  /** Where unqualified names are looked up, for completion. */
  defaultSchema: string
  /** The database's kind, for the editor's dialect. */
  kind: string
  active: boolean
  onHistory(): void
}

let runs = 0
const queryId = () => `q${Date.now().toString(36)}${(runs++).toString(36)}`

/** A SQL editor's tab: the editor above, each statement's result below. */
export function QueryTab({
  id,
  sql,
  onChange,
  schema,
  defaultSchema,
  kind,
  active,
  onHistory,
}: Props) {
  const { api, connection, scope, log, showRow } = useWorkspace()
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [shown, setShown] = useState(0)
  const [running, setRunning] = useState<string | null>(null)
  const [pending, setPending] = useState<Statement[] | null>(null)
  const [selected, setSelected] = useState<Cell | null>(null)
  const [editorShare, setEditorShare] = useState(45)
  const body = useRef<HTMLDivElement>(null)
  const unmounted = useRef(false)
  useEffect(
    () => () => {
      unmounted.current = true
    },
    [],
  )

  function run(mode: 'current' | 'all', text: string, cursor: number) {
    if (running) return
    const statements = splitStatements(text)
    const targets =
      mode === 'all' ? statements : [statementAt(statements, cursor)].filter((s) => s !== null)
    if (!targets.length) return
    // Production asks before anything that may change it.
    if (
      connection.tag === 'production' &&
      connection.access === 'write' &&
      targets.some((s) => looksLikeWrite(s.text))
    ) {
      setPending(targets)
      return
    }
    void execute(targets)
  }

  async function execute(targets: Statement[]) {
    const done: Outcome[] = []
    setOutcomes([])
    setShown(0)
    setSelected(null)
    for (const statement of targets) {
      const id = queryId()
      setRunning(id)
      const started = performance.now()
      try {
        const result = await api.query(connection.name, statement.text, id)
        done.push({ statement, result })
        log({ statement: statement.text, durationMs: result.durationMs })
      } catch (e) {
        const error = e instanceof ApiError ? e : new ApiError(0, 'failed', (e as Error).message)
        done.push({ statement, error })
        log({
          statement: statement.text,
          durationMs: Math.round(performance.now() - started),
          error: error.message,
        })
        break
      } finally {
        remember(scope, statement.text)
      }
      if (unmounted.current) return
      setOutcomes([...done])
    }
    if (unmounted.current) return
    setOutcomes(done)
    // The last result, or the failure, is the one to look at.
    setShown(done.length - 1)
    setRunning(null)
    onHistory()
  }

  async function cancel() {
    if (running) await api.cancel(running)
  }

  const outcome = outcomes[shown]
  const result = outcome?.result

  useEffect(() => {
    if (!active) return
    const row = result && selected ? result.rows[selected.row] : undefined
    showRow(row && result ? { columns: result.columns, values: row } : null)
  }, [active, result, selected, showRow])

  function drag(event: ReactMouseEvent) {
    event.preventDefault()
    const box = body.current!.getBoundingClientRect()
    const onMove = (e: MouseEvent) =>
      setEditorShare(Math.max(15, Math.min(85, ((e.clientY - box.top) / box.height) * 100)))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="tab-body" hidden={!active}>
      {connection.warning && (
        <div className="notice warning" role="note">
          {connection.warning}
        </div>
      )}
      <div className="query" ref={body} style={{ ['--editor' as string]: `${editorShare}%` }}>
        <Editor
          value={sql}
          onChange={onChange}
          onRun={run}
          schema={schema}
          defaultSchema={defaultSchema}
          kind={kind}
          label={`SQL editor ${id}`}
        />
        <div
          className="splitter"
          role="separator"
          aria-orientation="horizontal"
          onMouseDown={drag}
        />
        <div className="results">
          {outcomes.length > 1 && (
            <div className="results-tabs" role="tablist" aria-label="Results">
              {outcomes.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  className="button"
                  aria-selected={i === shown}
                  onClick={() => {
                    setShown(i)
                    setSelected(null)
                  }}
                >
                  {o.error ? '⚠ ' : ''}Result {i + 1}
                </button>
              ))}
            </div>
          )}
          {outcome?.error && <QueryErrorView outcome={outcome} sql={sql} />}
          {result && result.columns.length > 0 && (
            <DataGrid
              label="Result"
              columns={result.columns}
              rows={result.rows}
              selected={selected}
              onSelect={setSelected}
            />
          )}
          {result && !result.columns.length && (
            <div className="message" role="status">
              {result.command}
              {result.affectedRows !== null &&
                ` · ${result.affectedRows.toLocaleString()} rows affected`}{' '}
              · {result.durationMs} ms
            </div>
          )}
          {!outcomes.length && !running && (
            <div className="message">
              Results show here. ⌘↵ runs the statement at the cursor, ⇧⌘↵ all of them.
            </div>
          )}
        </div>
      </div>
      <div className="bottombar">
        {running ? (
          <button type="button" className="button danger" onClick={cancel}>
            <Icon name="stop" size={12} /> Cancel
          </button>
        ) : (
          <span>{connection.access === 'read' ? 'Read-only connection' : ''}</span>
        )}
        <span className="spacer" />
        {result && result.columns.length > 0 && (
          <ExportMenu
            formats={['csv', 'json']}
            onExport={(format) => {
              const names = result.columns.map((c) => c.name)
              const text = format === 'csv' ? toCsv(names, result.rows) : toJson(names, result.rows)
              const type = format === 'csv' ? 'text/csv' : 'application/json'
              download(new Blob([text], { type: `${type};charset=utf-8` }), `result.${format}`)
            }}
          />
        )}
        <span aria-live="polite">
          {running
            ? 'Running…'
            : result
              ? `${result.rows.length.toLocaleString()} rows${result.truncated ? ' (cut at the row limit)' : ''} · ${result.durationMs} ms`
              : ''}
        </span>
      </div>
      {pending && (
        <ConfirmDialog
          title="Run on production?"
          confirmLabel="Run"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const targets = pending
            setPending(null)
            void execute(targets)
          }}
        >
          <p>
            <strong>{connection.label}</strong> is tagged production. This may change it:
          </p>
          <pre>{pending.map((s) => s.text).join(';\n\n')}</pre>
        </ConfirmDialog>
      )}
    </div>
  )
}

/** The database's error, with where in the editor's text it points. */
function QueryErrorView({ outcome, sql }: { outcome: Outcome; sql: string }) {
  const { error, statement } = outcome
  let where = ''
  if (error?.position) {
    const offset = statement.from + error.position - 1
    const before = sql.slice(0, offset)
    const line = before.split('\n').length
    const column = offset - before.lastIndexOf('\n')
    where = ` (line ${line}, column ${column})`
  }
  return (
    <div className="notice" role="alert">
      {error!.message}
      {where}
      {error!.sqlState && <div className="detail">SQLSTATE {error!.sqlState}</div>}
      {error!.detail && <div className="detail">{error!.detail}</div>}
      {error!.hint && <div className="detail">Hint: {error!.hint}</div>}
    </div>
  )
}
