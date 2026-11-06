# @otwdesign/plugin-db

## 1.0.2

### Patch Changes

- 69e22b8: Two fixes in the app:

  - Opening the Console no longer crashes the app. In today's Chrome `scrollIntoView()` returns a promise, and the console's effect handed it to React as its cleanup.
  - Export works where the app sits in a shadow root: the CMS's Database screen, and any page with `<otw-db-app>`. A click on a format was taken for a click outside the menu, which closed first.

- Updated dependencies [69e22b8]
  - @otwdesign/db-ui@1.0.2
  - @otwdesign/db-core@1.0.2

## 1.0.1

### Patch Changes

- 175e4a1: The Database screen no longer adds `<otw-db-app>` to the site's JSX types. A site that links the plugin from a checkout, with its own copy of React's types, now type-checks.
- Updated dependencies [175e4a1]
  - @otwdesign/db-core@1.0.1
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
  - @otwdesign/db-core@1.0.0
  - @otwdesign/db-ui@1.0.0
