/** The browser app's files, as `vite build` made them, for `@otwdesign/db-core` to serve. */
export declare const assets: {
  /** The page, with `%OTW_DB_CONFIG%` where its settings go and `%OTW_DB_BASE%` before each file. */
  index: string
  /** Files under `assets/`, by name; their names change with their content. */
  files: Readonly<Record<string, { type: string; body: string }>>
}
