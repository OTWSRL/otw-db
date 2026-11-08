---
'@otwdesign/db-core': minor
'@otwdesign/db-ui': minor
---

Back up and restore, from the toolbar, for PostgreSQL connections and the CMS's embedded database.
A backup is a `.sql.gz` the tool writes from the catalog in one read-only snapshot (schemas,
extensions, types, sequences, tables and their rows, keys, indexes, views, functions, triggers,
policies, comments, owners and privileges), or pg_dump's `.dump` where the server has pg_dump.
What a SQL backup can't hold is listed before it's downloaded. A restore replaces the backup's
schemas in one transaction: nothing changes if any part fails, if the file was cut short, or if
something outside those schemas depends on what it would drop. The browser uploads the file in
4 MB pieces, which wait in the database itself, so it works on Vercel. Restoring needs a `write`
connection; `backups.maxRestoreBytes` caps its size (1 GB by default).
