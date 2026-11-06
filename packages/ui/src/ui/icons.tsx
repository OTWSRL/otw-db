/** OTW DB's own icons: 16-pixel strokes in the text's color. */
const PATHS = {
  table: 'M2.5 3.5h11v9h-11z M2.5 6.5h11 M6.5 6.5v6',
  view: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z',
  stack: 'M8 2.5l5.5 2.75L8 8 2.5 5.25z M2.5 8L8 10.75 13.5 8 M2.5 10.75L8 13.5l5.5-2.75',
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  plus: 'M8 3.5v9 M3.5 8h9',
  minus: 'M3.5 8h9',
  refresh: 'M12.5 5.5A5 5 0 1 0 13 9 M12.5 2.5v3h-3',
  sidebar: 'M2.5 3.5h11v9h-11z M6 3.5v9',
  panel: 'M2.5 3.5h11v9h-11z M10 3.5v9',
  console: 'M2.5 3.5h11v9h-11z M5 7l2 1.5L5 10 M8.5 10h2.5',
  search: 'M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M10 10l3.5 3.5',
  close: 'M4.5 4.5l7 7 M11.5 4.5l-7 7',
  left: 'M10 3.5L5.5 8l4.5 4.5',
  right: 'M6 3.5l4.5 4.5L6 12.5',
  filter: 'M2.5 3.5h11L9.5 8.5v4l-3-1.5v-2.5z',
  sql: 'M5.5 5L3 8l2.5 3 M10.5 5L13 8l-2.5 3 M9 4l-2 8',
  key: 'M10 2.5a3.5 3.5 0 1 1-2.6 5.9L3.5 12.3v1.2H2.3v-1.2l3.9-3.9A3.5 3.5 0 0 1 10 2.5z',
  lock: 'M4.5 7.5h7v5.5h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2',
  database:
    'M3 4c0-1.1 2.2-1.5 5-1.5s5 .4 5 1.5v8c0 1.1-2.2 1.5-5 1.5s-5-.4-5-1.5z M3 4c0 1.1 2.2 1.5 5 1.5s5-.4 5-1.5 M3 8c0 1.1 2.2 1.5 5 1.5s5-.4 5-1.5',
  switch: 'M3 5.5h9.5L10 3 M13 10.5H3.5L6 13',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9 M2.5 2.5v2.5H5 M8 5v3l2 1.5',
  save: 'M3 2.5h8l2 2v9H3z M5.5 2.5v3h4v-3 M5 13.5v-4h6v4',
} as const

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 16,
  label,
}: {
  name: IconName
  size?: number
  label?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The icon for a table's kind in the tree and the palette. */
export function kindIcon(kind: string): IconName {
  if (kind === 'view') return 'view'
  if (kind === 'materialized-view') return 'stack'
  return 'table'
}
