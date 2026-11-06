# OTW DB: plan

A database manager in the spirit of phpMyAdmin that runs inside other apps: as an OTW CMS plugin,
in any Next.js app, and in any Node application (node:http, Express, Fastify, Koa, Hono, Nest), or
on its own from the command line. Apache-2.0.

## Decisions (Tahir, 2026-11-06)

- Package names: `@otwdesign/db-core`, `@otwdesign/db-ui`, `@otwdesign/db-node`,
  `@otwdesign/plugin-db`. `db-next` was dropped: a Next.js route handler takes the core's Fetch
  handler as it is, so it would have held nothing.
- Connections come from environment variables (or the host's code). None are saved from the UI in v1.
- v1 databases: PostgreSQL, MySQL/MariaDB, SQLite.
- Apache-2.0, like the CMS.
- Usable in any Node application, not only Next.js and the CMS.

## Shape

One engine, one HTTP surface, thin hosts.

| Package                | Holds                                                                               | Depends on         |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `@otwdesign/db-core`   | Drivers, introspection, queries, the Fetch handler (API and UI assets)              | Node 22.18+ only   |
| `@otwdesign/db-ui`     | The browser app, prebuilt (Vite), with its own React inside                         | nothing at run     |
| `@otwdesign/db-node`   | `toNodeHandler()` for node:http-style servers                                       | `db-core`          |
| `@otwdesign/db`        | The `otw-db` command with every driver, for `npx @otwdesign/db` (Tahir, 2026-11-07) | `db-node`, drivers |
| `@otwdesign/plugin-db` | The OTW CMS plugin                                                                  | `db-core`, SDK     |

- **The Fetch handler is the contract.** `createDbAdmin(options)` returns `fetch(request)`, a
  standard `Request → Response` function, and `routes`, the same endpoints as a flat list.
  Next.js route handlers, Hono, Bun and the CMS's `cms.routes.api` take Fetch handlers directly;
  node:http, Express, Connect, Koa, Fastify and Nest go through `toNodeHandler()`.
- **The API is flat:** each path has at most one parameter, no catch-alls, so any router can mount
  it, including the CMS's, which matches fixed segments only.
- **The UI is a prebuilt app** the handler serves itself (HTML plus hashed assets). Hosts need no
  React, no bundler step and no Tailwind, and its CSS can't collide with theirs. It also exports
  `mount(element, options)`, which the CMS plugin uses to show it inside the admin, themed by CSS
  variables.
- **Compiled ESM and `.d.ts`.** Plain Node can't import TypeScript from `node_modules`. CommonJS
  apps load it through `require(esm)` (Node 22.12+).

## The host contract

```ts
createDbAdmin({
  basePath: '/db', // where it's mounted
  authorize: (request) => viewer | null, // required: fails closed without it
  connections: connectionsFromEnv(), // or a list in code
  audit: (event) => {}, // every query run; defaults to one JSON line on stdout
})
```

- `authorize` returns who is asking (`{ id }`) and, optionally, their access to each connection.
- Connections: `DB_ADMIN_<NAME>_URL`, `DB_ADMIN_<NAME>_ACCESS` (`read`, the default, or `write`),
  `DB_ADMIN_<NAME>_LABEL`. The URL's scheme picks the driver: `postgres:`/`postgresql:`,
  `mysql:`/`mariadb:`, `sqlite:`/`file:`. Credentials never reach the browser: it names
  connections only.
- The standalone command, `otw-db`, listens on 127.0.0.1 and signs in with a one-time token it
  prints, like Jupyter.
- In the CMS: the `manage_database` capability (administrators), the CMS's sign-in, and the CMS's
  own database as a read-only default connection, opened through `cms.db` (PGlite allows one
  process, so the plugin can't open it a second time).

## No cost to the host

- Nothing runs until a request reaches the mount path: no middleware, no boot work.
- Drivers are optional peer dependencies, imported on the first query of their kind, so a host
  installs only what it uses.
- In the CMS, the main entry only declares the capability; the rest is in the admin entry.
  Measure boot and a public page with and without it (CMS rule: not even 1 ms).

## Safety

- `read` access runs each query in a read-only transaction, with the extended protocol, which
  takes one statement, so `COMMIT; DROP …` can't step out of it. The database role is still the
  real boundary: point read connections at a role with SELECT only.
- Every query has a statement timeout and a row limit; results past the limit are cut, and say so.
- Destructive statements (`DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`) ask first (UI).
- API calls need a JSON body where they have one and the `x-db-admin: 1` header, which a
  cross-site form can't send; a cross-origin `Origin` is refused.
- Values reach the browser as the database's own text, never as HTML.
- Every query goes to `audit`.

## The UI: TablePlus's way of working (Tahir, 2026-11-06)

It works the way TablePlus does: dense, fast, keyboard-first, and native-feeling. The name,
icons and artwork are our own; none of TablePlus's branding or assets.

- **Connections:** a list grouped by tag. Each connection has an environment color (`local`,
  `development`, `testing`, `staging`, `production`; `DB_ADMIN_<NAME>_TAG`). The open window
  shows it in a pill in the toolbar, such as `PostgreSQL 17 : main : shop`, in its color.
  Production asks before every write.
- **Window:**
  - a toolbar;
  - the left sidebar:
    - schema picker;
    - "Search for item…";
    - tree of tables, views, materialized views and functions;
    - Items / Queries / History at the bottom;
  - tabs for open tables and SQL editors, like a browser's;
  - a right sidebar with the selected row's fields, one per line, editable;
  - a console of every statement run.
- **Table tab:**
  - a virtualized grid with sortable column headers;
  - a filter bar (column, operator, value; several at once; Apply);
  - at the bottom:
    - a Data / Structure switch;
    - pagination;
    - "+ Row";
    - the row count, estimated or exact.
- **Edits are staged:**
  - Changed cells, new rows and deleted rows are highlighted.
  - ⌘S reviews them as SQL, then applies them in one transaction.
  - ⌘Z or Discard drops them.
- **Structure tab:**
  - the columns (name, type, nullable, default, foreign key, comment);
  - below them, the indexes, foreign keys and checks.
- **SQL editor:**
  - CodeMirror 6, with completion of the schema's tables and columns;
  - ⌘↵ runs the statement under the cursor; ⇧⌘↵ runs everything;
  - the results grid below, one tab per statement;
  - Cancel while running;
  - history, and saved queries (in the browser in v1).
- **Shortcuts:**
  - ⌘P: open anything;
  - ⌘E: new SQL editor;
  - ⌘R: refresh;
  - ⌘F: filter;
  - ⌘S: commit;
  - ⌥W: close tab (browsers keep ⌘W for their own tabs);
  - ⌘[ / ⌘]: switch tab.
- **Themes:** light and dark, following the system.

## Values

Postgres values come back as the server's text (no JavaScript conversion: timestamps keep their
zone, numerics and int8 their digits, json its spelling), rows as arrays beside one column list.

## Milestones

1. **Engine** (`db-core`, `db-node`), done 2026-11-06: the driver contract and capability flags, Postgres
   (introspection, browsing, queries with timeout, row limit, read-only mode, cancel),
   environment connections, the Fetch handler, the Node adapter, the `otw-db` command. Tests on
   real Postgres in Docker.
2. **UI** (`db-ui`), done 2026-11-07, without saved queries (history only) and `mount()` untried in
   a host: connections, schema tree, table browser (virtualized grid), SQL editor
   (CodeMirror 6, schema-aware), results; served by the handler; `mount()`.
3. **Editing and export**, done 2026-11-07: row edits as previewed SQL in one transaction, destructive-statement
   confirmation, CSV/JSON/SQL export streamed.
4. **MySQL/MariaDB and SQLite**, and one conformance suite all drivers pass, done 2026-11-07.
5. **Hosts**, done 2026-11-07 (Fastify, Koa, Hono, Next.js example, CMS plugin with its site): Next.js and Express/Fastify/Koa/Hono examples with e2e; the CMS plugin with its site.
6. **Release:** docs (the docs site), installs of the packed tarballs into fresh Next.js, Express and
   CMS sites in CI, Changesets, trusted publishing.

## Open questions

- Cancel through a proxy that requires TLS with SNI (Neon) can't reach the server with pg's cancel
  request; the statement timeout still stops the query.

## Ports

e2e servers: 3470 (Next.js example), 3471 (CMS site), 3472 (Node examples). The CMS family uses
3100 and 3410–3460.
