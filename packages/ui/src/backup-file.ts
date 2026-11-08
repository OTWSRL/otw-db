import type { BackupHeader } from './api.ts'

/** What a file chosen to restore turns out to be. */
export type BackupFile =
  { kind: 'sql'; header: BackupHeader } | { kind: 'pg_dump' } | { kind: 'unknown'; reason: string }

const PREFIX = '-- otw-db backup '
/** How far into the file its first line may end. */
const FIRST_LINE = 1_048_576

/**
 * Reads what a file holds from its start alone: an otw-db backup's first line (gzipped or not),
 * or pg_dump's archive by its signature. The rest stays unread until it's uploaded.
 */
export async function readBackupFile(file: Blob): Promise<BackupFile> {
  const start = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  if (new TextDecoder().decode(start) === 'PGDMP') return { kind: 'pg_dump' }
  const gzipped = start[0] === 0x1f && start[1] === 0x8b
  let line: string | null
  try {
    line = await firstLine(
      gzipped ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream(),
    )
  } catch {
    return { kind: 'unknown', reason: 'The file can’t be read: it may be damaged.' }
  }
  if (line === null || !line.startsWith(PREFIX)) {
    return {
      kind: 'unknown',
      reason:
        'This isn’t a backup made here: choose a .sql.gz from Back up, or a .dump from pg_dump.',
    }
  }
  try {
    return { kind: 'sql', header: JSON.parse(line.slice(PREFIX.length)) as BackupHeader }
  } catch {
    return { kind: 'unknown', reason: 'The backup’s first line is damaged.' }
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  // TypeScript's DOM types take a TextDecoderStream's input as any BufferSource; bytes it is.
  const decode = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>
  const reader = stream.pipeThrough(decode).getReader()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) text += value
      const end = text.indexOf('\n')
      if (end !== -1) return text.slice(0, end)
      if (done || text.length > FIRST_LINE) return null
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
