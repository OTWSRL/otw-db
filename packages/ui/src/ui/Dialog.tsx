import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  /** While true, the confirm button waits (a request is on its way). */
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

/**
 * A question to confirm or cancel; Escape cancels, the confirm button has the focus, and the focus
 * goes back where it was afterwards.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Back to what had the focus (the editor, say) when the dialog goes, as native dialogs do.
    const before = document.activeElement as HTMLElement | null
    confirm.current?.focus()
    return () => before?.focus()
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      >
        <div className="dialog-body">
          <h2>{title}</h2>
          {children}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            className={`button ${danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
