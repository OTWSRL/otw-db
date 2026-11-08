import { useEffect, useRef, useState } from 'react'
import type {
  Api,
  ApiError,
  BackupOptions,
  Connection,
  RestorePlan,
  RestoreResult,
} from '../api.ts'
import { readBackupFile, type BackupFile } from '../backup-file.ts'
import { download } from '../ui/ExportMenu.tsx'

type Tab = 'backup' | 'restore'
type Phase =
  | { step: 'idle' }
  | { step: 'uploading'; sent: number }
  | { step: 'restoring'; statements: number }
  | { step: 'done'; result: RestoreResult & { durationMs: number } }
  | { step: 'failed'; message: string }

/**
 * Back up the database to a file, or restore one: TablePlus's Backup and Restore. What the
 * database holds is asked for when the dialog opens, never before.
 */
export function BackupDialog({
  api,
  connection,
  onRestored,
  onClose,
}: {
  api: Api
  connection: Connection
  /** After a restore: what the workspace shows is out of date. */
  onRestored(): void
  onClose(): void
}) {
  const [tab, setTab] = useState<Tab>('backup')
  const [options, setOptions] = useState<BackupOptions | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const restoring = useRef(false)

  useEffect(() => {
    let current = true
    api.backupOptions(connection.name).then(
      (answer) => current && setOptions(answer),
      (e: unknown) => current && setError(e as ApiError),
    )
    return () => {
      current = false
    }
  }, [api, connection.name])

  const close = () => {
    // A restore goes on on the server either way; the dialog stays to say how it ends.
    if (!busy && !restoring.current) onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="dialog backup"
        role="dialog"
        aria-modal="true"
        aria-label="Back up and restore"
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <div className="tabs" role="tablist" aria-label="Back up or restore">
          {(['backup', 'restore'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`backup-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`backup-panel-${t}`}
              disabled={busy}
              onClick={() => setTab(t)}
            >
              {t === 'backup' ? 'Back up' : 'Restore'}
            </button>
          ))}
        </div>
        {error && (
          <div className="dialog-body">
            <div className="notice" role="alert">
              {error.message}
            </div>
          </div>
        )}
        {!options && !error && <div className="dialog-body muted">Loading…</div>}
        {options && tab === 'backup' && (
          <BackupPanel
            api={api}
            connection={connection}
            options={options}
            busy={busy}
            setBusy={setBusy}
            onClose={close}
          />
        )}
        {options && tab === 'restore' && (
          <RestorePanel
            api={api}
            connection={connection}
            options={options}
            setBusy={(b) => {
              restoring.current = b
              setBusy(b)
            }}
            busy={busy}
            onRestored={onRestored}
            onClose={close}
          />
        )}
        {!options && (
          <div className="dialog-actions">
            <button type="button" className="button" onClick={close}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function BackupPanel({
  api,
  connection,
  options,
  busy,
  setBusy,
  onClose,
}: {
  api: Api
  connection: Connection
  options: BackupOptions
  busy: boolean
  setBusy(busy: boolean): void
  onClose(): void
}) {
  const [chosen, setChosen] = useState(
    () => new Set(options.schemas.filter((s) => s.selected).map((s) => s.name)),
  )
  const [format, setFormat] = useState<'sql' | 'pg_dump'>('sql')
  const [error, setError] = useState<string | null>(null)
  const missing = options.notIncluded.filter((x) => x.schema === null || chosen.has(x.schema))

  const toggle = (name: string) =>
    setChosen((now) => {
      const next = new Set(now)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const backUp = async () => {
    setBusy(true)
    setError(null)
    try {
      const schemas = options.schemas.filter((s) => chosen.has(s.name)).map((s) => s.name)
      const { blob, filename } = await api.backup({ connection: connection.name, schemas, format })
      download(blob, filename)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="tabpanel" id="backup-panel-backup" aria-labelledby="backup-tab-backup">
      <div className="dialog-body">
        <p className="muted">
          {options.database} on {options.server}
        </p>
        <fieldset className="choices">
          <legend>Schemas</legend>
          {options.schemas.map((s) => (
            <label key={s.name}>
              <input
                type="checkbox"
                checked={chosen.has(s.name)}
                disabled={busy}
                onChange={() => toggle(s.name)}
              />
              <span>{s.name}</span>
              <span className="muted">
                {s.tables === 1 ? '1 table' : `${s.tables.toLocaleString()} tables`}
                {s.mine ? '' : ` · owner ${s.owner}`}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="choices">
          <legend>Format</legend>
          <label>
            <input
              type="radio"
              name="backup-format"
              checked={format === 'sql'}
              disabled={busy}
              onChange={() => setFormat('sql')}
            />
            <span>SQL backup (.sql.gz)</span>
            <span className="muted">restores here, or with psql</span>
          </label>
          <label title={options.pgDump.available ? undefined : options.pgDump.reason}>
            <input
              type="radio"
              name="backup-format"
              checked={format === 'pg_dump'}
              disabled={busy || !options.pgDump.available}
              onChange={() => setFormat('pg_dump')}
            />
            <span>pg_dump (.dump)</span>
            <span className="muted">
              {options.pgDump.available ? 'restores with pg_restore' : options.pgDump.reason}
            </span>
          </label>
        </fieldset>
        {options.exclusive && (
          <div className="notice warning">
            This is the site’s embedded database: the site waits while the backup is taken.
          </div>
        )}
        {format === 'sql' && missing.length > 0 && (
          <div className="notice warning">
            Not in the backup: {missing.map((x) => x.what).join('; ')}. Use pg_dump for those.
          </div>
        )}
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || chosen.size === 0}
          onClick={() => void backUp()}
        >
          {busy ? 'Backing up…' : 'Download backup'}
        </button>
      </div>
    </div>
  )
}

function RestorePanel({
  api,
  connection,
  options,
  busy,
  setBusy,
  onRestored,
  onClose,
}: {
  api: Api
  connection: Connection
  options: BackupOptions
  busy: boolean
  setBusy(busy: boolean): void
  onRestored(): void
  onClose(): void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [what, setWhat] = useState<BackupFile | null>(null)
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>({ step: 'idle' })

  const choose = async (chosen: File | null) => {
    setFile(chosen)
    setWhat(null)
    setPlan(null)
    setPlanError(null)
    setPhase({ step: 'idle' })
    if (!chosen) return
    const read = await readBackupFile(chosen)
    setWhat(read)
    if (read.kind !== 'sql') return
    try {
      setPlan(await api.restorePlan(connection.name, read.header))
    } catch (e) {
      setPlanError((e as Error).message)
    }
  }

  const kind = what?.kind === 'pg_dump' ? 'pg_dump' : 'sql'
  const blocked = (plan?.blocked.length ?? 0) > 0
  const ready =
    options.restore.allowed &&
    file !== null &&
    what !== null &&
    what.kind !== 'unknown' &&
    (what.kind === 'pg_dump' ? options.pgRestore.available : plan !== null && !blocked) &&
    typed === options.database &&
    phase.step === 'idle'

  const restore = async () => {
    if (!file) return
    setBusy(true)
    setPhase({ step: 'uploading', sent: 0 })
    try {
      const last = await api.restore(
        connection.name,
        file,
        kind,
        (sent) => setPhase({ step: 'uploading', sent }),
        (line) => {
          if (line.type === 'progress') setPhase({ step: 'restoring', statements: line.statements })
        },
      )
      if (last.type === 'done') {
        setPhase({ step: 'done', result: last })
        onRestored()
      } else if (last.type === 'error') setPhase({ step: 'failed', message: last.error.message })
    } catch (e) {
      setPhase({ step: 'failed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="tabpanel" id="backup-panel-restore" aria-labelledby="backup-tab-restore">
      <div className="dialog-body">
        {!options.restore.allowed ? (
          <div className="notice warning">
            Restoring needs write access, and this connection is read-only.
          </div>
        ) : (
          <>
            <label className="file-choice">
              <span>Backup file</span>
              <input
                type="file"
                accept=".gz,.sql,.dump,application/gzip,application/sql"
                disabled={busy}
                onChange={(e) => void choose(e.target.files?.[0] ?? null)}
              />
            </label>
            {what?.kind === 'unknown' && (
              <div className="notice" role="alert">
                {what.reason}
              </div>
            )}
            {what?.kind === 'sql' && (
              <p className="muted">
                Backup of {what.header.database} ({what.header.server}), made{' '}
                {new Date(what.header.createdAt).toLocaleString()}: {what.header.schemas.join(', ')}
                .
              </p>
            )}
            {what?.kind === 'pg_dump' && (
              <>
                <p className="muted">pg_dump archive, {size(file?.size ?? 0)}.</p>
                {!options.pgRestore.available && (
                  <div className="notice" role="alert">
                    {options.pgRestore.reason} Restore it with pg_restore from a machine that has
                    it.
                  </div>
                )}
              </>
            )}
            {planError && (
              <div className="notice" role="alert">
                {planError}
              </div>
            )}
            {plan && <Replaces plan={plan} database={options.database} />}
            {what?.kind === 'sql' && what.header.notIncluded.length > 0 && (
              <div className="notice warning">
                The backup didn’t hold: {what.header.notIncluded.join('; ')}.
              </div>
            )}
            {options.exclusive && what && what.kind !== 'unknown' && (
              <div className="notice warning">
                This is the site’s embedded database: the site waits while it’s restored.
              </div>
            )}
            {what && what.kind !== 'unknown' && (!blocked || what.kind === 'pg_dump') && (
              <label className="confirm">
                <span>
                  Type <strong>{options.database}</strong> to replace what it holds
                </span>
                <input
                  className="input"
                  aria-label="Database name, to confirm"
                  value={typed}
                  disabled={busy || phase.step === 'done'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
            )}
            <Progress phase={phase} total={file?.size ?? 0} />
          </>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          {phase.step === 'done' ? 'Close' : 'Cancel'}
        </button>
        {options.restore.allowed && (
          <button
            type="button"
            className="button danger"
            disabled={!ready || busy}
            onClick={() => void restore()}
          >
            {busy ? 'Restoring…' : 'Restore'}
          </button>
        )}
      </div>
    </div>
  )
}

/** What the restore replaces, what stops it, and what it can't bring back. */
function Replaces({ plan, database }: { plan: RestorePlan; database: string }) {
  return (
    <>
      <div className="replaces">
        <p>Replaces in {database}:</p>
        <ul>
          {plan.schemas.map((s) => (
            <li key={s.schema}>
              <strong>{s.schema}</strong>{' '}
              {s.exists ? (
                <span className="muted">
                  {count(s.tables, 'table')}, {count(s.views, 'view')},{' '}
                  {count(s.functions, 'function')}
                  {/* Before statistics are gathered, PostgreSQL's estimate is no help. */}
                  {s.rows > 0 && `, about ${count(s.rows, 'row')}`}
                </span>
              ) : (
                <span className="muted">new here</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {plan.blocked.length > 0 && (
        <div className="notice" role="alert">
          Restoring would also drop what’s outside the backup:
          <ul>
            {plan.blocked.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          Back up those schemas too, or remove what depends on them.
        </div>
      )}
      {plan.missingRoles.length > 0 && (
        <div className="notice warning">
          These roles aren’t on this server, so their grants and policies will be skipped:{' '}
          {plan.missingRoles.join(', ')}.
        </div>
      )}
      {plan.warnings.map((w) => (
        <div key={w} className="notice warning">
          {w}
        </div>
      ))}
    </>
  )
}

function Progress({ phase, total }: { phase: Phase; total: number }) {
  switch (phase.step) {
    case 'idle':
      return null
    case 'uploading':
      return (
        <div className="progress" role="status">
          <progress max={total || 1} value={phase.sent} />
          Uploading {size(phase.sent)} of {size(total)}…
        </div>
      )
    case 'restoring':
      return (
        <div className="progress" role="status">
          <progress />
          Restoring: {count(phase.statements, 'statement')} run…
        </div>
      )
    case 'done':
      return (
        <div className="notice success" role="status">
          Restored
          {phase.result.tables
            ? ` ${count(phase.result.tables, 'table')} and ${count(phase.result.rows, 'row')}`
            : ''}{' '}
          in{' '}
          {(phase.result.durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}{' '}
          s. If an app uses this database, restart it: it may keep what it read before.
        </div>
      )
    case 'failed':
      return (
        <div className="notice" role="alert">
          {phase.message}
        </div>
      )
  }
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
}
