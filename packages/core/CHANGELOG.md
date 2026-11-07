# @otwdesign/db-core

## 1.1.0

### Minor Changes

- ab60209: PostgreSQL connections work in a CMS site installed with pnpm. pnpm keeps the plugin's `pg` and `pg-cursor` beside the plugin, not in the site's root, so db-core couldn't import them from where the site's bundle runs. `postgresDriver(url, { modules })` and `openDriver(connection, { postgres })` now take them from the host, and the plugin hands over its own. A driver that failed to load is tried again on the next request.

### Patch Changes

- @otwdesign/db-ui@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies [69e22b8]
  - @otwdesign/db-ui@1.0.2

## 1.0.1

### Patch Changes

- 175e4a1: Every export has a doc comment, shown in editors and in the OTW CMS Code Reference.
- @otwdesign/db-ui@1.0.1

## 1.0.0

### Major Changes

- OTW DB 1.0.0: a database manager for PostgreSQL, MySQL, MariaDB and SQLite, in OTW CMS, Next.js, any
  Node app, or on its own. It works the way TablePlus does: connections in environment colors, a
  sidebar of tables, tabs, a fast grid with a filter bar, the table's structure, edits reviewed as SQL
  and committed in one transaction, exports, and a SQL editor that runs the statement at the cursor.
  Read-only connections, a time limit and a row limit on every statement, sign-in from the host, and
  an audit log of every statement run.

### Patch Changes

- Updated dependencies
  - @otwdesign/db-ui@1.0.0
