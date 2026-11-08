# @otwdesign/db-ui

## 1.3.0

### Minor Changes

- f6b729b: Back up and restore, from the toolbar, for PostgreSQL connections and the CMS's embedded database.
  A backup is a `.sql.gz` the tool writes from the catalog in one read-only snapshot (schemas,
  extensions, types, sequences, tables and their rows, keys, indexes, views, functions, triggers,
  policies, comments, owners and privileges), or pg_dump's `.dump` where the server has pg_dump.
  What a SQL backup can't hold is listed before it's downloaded. A restore replaces the backup's
  schemas in one transaction: nothing changes if any part fails, if the file was cut short, or if
  something outside those schemas depends on what it would drop. The browser uploads the file in
  4 MB pieces, which wait in the database itself, so it works on Vercel. Restoring needs a `write`
  connection; `backups.maxRestoreBytes` caps its size (1 GB by default).

## 1.2.0

### Minor Changes

- 2bbcc89: A PostgreSQL connection opens any database on its server that its login may connect to. Click the database's name in the toolbar, or press ⌘K, to pick another one. Each database has its own tabs and history, and the address names it (`#main/archive`), so a reload comes back to it.

  - `GET /api/databases?connection=` lists the databases. Every other endpoint takes a `database` (a query parameter for GET, a body field for POST), and the audit log records it.
  - Each database gets its own pool, which opens on first use. The 8 used last stay open, and opening another closes the one used longest ago.
  - `DB_ADMIN_<NAME>_DATABASES=one` (`databases: 'one'` in code) pins a connection to its URL's database.
  - Drivers can offer the feature with `databases()` and `withDatabase(name)`. The PostgreSQL driver has both.

## 1.1.0

No changes in this release.

## 1.0.2

### Patch Changes

- 69e22b8: Two fixes in the app:

  - Opening the Console no longer crashes the app. In today's Chrome `scrollIntoView()` returns a promise, and the console's effect handed it to React as its cleanup.
  - Export works where the app sits in a shadow root: the CMS's Database screen, and any page with `<otw-db-app>`. A click on a format was taken for a click outside the menu, which closed first.

## 1.0.1

No changes in this release.

## 1.0.0

### Major Changes

- OTW DB 1.0.0: a database manager for PostgreSQL, MySQL, MariaDB and SQLite, in OTW CMS, Next.js, any
  Node app, or on its own. It works the way TablePlus does: connections in environment colors, a
  sidebar of tables, tabs, a fast grid with a filter bar, the table's structure, edits reviewed as SQL
  and committed in one transaction, exports, and a SQL editor that runs the statement at the cursor.
  Read-only connections, a time limit and a row limit on every statement, sign-in from the host, and
  an audit log of every statement run.
