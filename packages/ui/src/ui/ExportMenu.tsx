import { useEffect, useRef, useState } from 'react'
import type { ExportFormat } from '../api.ts'

const LABELS: Record<ExportFormat, string> = { csv: 'CSV', json: 'JSON', sql: 'SQL INSERTs' }

/** An "Export" button with a menu of formats; Escape or a click elsewhere closes it. */
export function ExportMenu({
  formats,
  onExport,
}: {
  formats: readonly ExportFormat[]
  onExport(format: ExportFormat): void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div
      style={{ position: 'relative' }}
      ref={box}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <button
        type="button"
        className="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Export
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Export as">
          {formats.map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onExport(format)
              }}
            >
              {LABELS[format]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Saves a file the way a download link does. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // After the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
