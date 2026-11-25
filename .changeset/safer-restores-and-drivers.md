---
'@otwdesign/db-core': minor
'@otwdesign/db-ui': minor
'@otwdesign/plugin-db': patch
---

Fixes from a review of the restore, the SQLite and PGlite drivers, edits and exports.

**Restore**

- A restore that failed part-way through a gzipped backup could end the host's process (an
  error nobody caught), and leave the request waiting. It now fails like any other.
- An upload with a piece missing in the middle is refused before anything runs.
- A backup that holds `COMMIT`, `BEGIN`, `ROLLBACK`, `SAVEPOINT` or `COPY` is refused: the restore
  stays one transaction. On PostgreSQL each statement also goes through the extended protocol,
  which takes one statement a query.
- The staging schema (`otw_db_restore`) must belong to the connection's login. One another role
  made, which could read the upload or change its pieces before they run, is refused.
- The database's name, typed in the dialog, is checked by the server too (`confirm` on
  `/api/restore-run`).
- A policy is restored for those of its roles the server has. Skipped whole when one was
  missing, a RESTRICTIVE policy left the others unrestricted. A comment on a skipped policy no
  longer fails the restore.
- Restored tables, sequences, functions and types get the backup's privileges whatever the
  server's default privileges (`ALTER DEFAULT PRIVILEGES`) add.
- The audit log's line for a restore has how many statements ran and the file's SHA-256.

**SQLite**

- Someone's own SQL runs on a handle of its own, closed after it: a `BEGIN` no longer leaves the
  shared connection in a transaction (later writes were reported as saved and never committed,
  and a reader's `BEGIN` held a lock on the host's file), and a TEMP view or a PRAGMA no longer
  reaches the next statement or the grid's edits.
- `ATTACH`, `DETACH` and `VACUUM INTO` are refused: they opened, or wrote, other files on the
  server, with read access too.

**PGlite (the CMS's embedded database)**

- A query's rows are read through a cursor: only those shown are built in the site's memory.
- After a statement or a restore, the session is put back as the site had it, instead of
  `DISCARD ALL`, which reset the site's own settings, temporary tables and LISTENs. A site's
  queries waiting behind a restore no longer run with the restore's `search_path`.
- Values go to PGlite as text, so a `bytea` key or filter works.

**Edits and exports**

- An edit is saved only if its cell still holds what it did when it was edited
  (`Change.original`); otherwise nothing is saved, and the message says what changed. Without
  `original`, an update goes by its key alone, as before.
- Rows whose key is bytes can be filtered, edited and deleted on MySQL, MariaDB and SQLite, and
  bytes typed as the grid shows them are stored as bytes.
- An SQL export puts its rows back: bytes as bytes, generated columns left out, identity columns
  with `OVERRIDING SYSTEM VALUE`. Its strings read the same in a PostgreSQL session with
  `standard_conforming_strings` off, and in a MySQL one in `NO_BACKSLASH_ESCAPES` mode, where a
  value with a backslash and a quote could end its string and run as SQL.

**Backups beside what they can't hold**

- A schema with a table that inherits another, a typed table or a foreign table can be backed
  up: the backup failed part-way, or named in its keys, indexes and triggers a table it didn't
  make. A foreign key from a table it holds to one it can't is listed as left out.
- A restore no longer drops what a backup can't hold. Foreign tables, typed tables, tables that
  inherit another and the sequences their columns own stay where they are; where one of them, an
  aggregate or an operator needs something the restore replaces, or something outside the
  schemas is built on an extension in them (a server on a foreign-data wrapper), the restore
  says what and refuses.
- Sequences go on from where they were: one restarted with `ALTER SEQUENCE … RESTART`, or set
  back with `setval(…, false)`, used to start over from 1.
- A restore the database is too busy for (something holds a table it replaces) now says so,
  which it never did for a lock met mid-restore, and keeps its upload: Try again in the dialog
  runs it without a second upload.
- A browser that goes away mid-restore stops it, changing nothing; the audit log says that, not
  that the backup wasn't valid UTF-8.

**Exports**

- PGlite: a table is exported a batch at a time from rows the database keeps aside, instead of
  whole into the site's memory, and the site's queries go on between batches.
- SQLite: each export reads on a thread of its own, so someone else's statement stopped at its
  time limit no longer ends it.
- MySQL and MariaDB: an export no longer leaves its time limit on the pooled connection, where
  it cut the next statement short; MariaDB exports have a limit at all. The limit is on the
  server sending nothing, so a big table isn't cut off for taking long.
- An export nobody reads for 5 minutes is ended on SQLite and PGlite too (`exportIdleMs`).

**Connections**

- A database the server doesn't list is answered with a 404, not opened: made-up names could
  push the eight databases kept open out one by one. A PostgreSQL driver that was closed stays
  closed, rather than open a pool nobody closes.

- PostgreSQL: a request that finds the pool's three connections held for 10 seconds fails and
  says so (`connectTimeoutMs`); an export nobody reads for 5 minutes is ended (`exportIdleMs`);
  a connection the server drops while the tool holds it no longer ends the process.
- MySQL and MariaDB: a statement past its limit whose `KILL QUERY` can't reach it has its
  connection closed two seconds later, instead of running on.

**From a second review**

- A restore can't be made to leave its transaction: a `--` comment ends at a carriage return, as
  the server ends it (`COMMIT` after one ran, and the restore said nothing was restored), and
  `PREPARE TRANSACTION` is found past comments. Behind that, the session is asked after every
  statement whether its transaction is still open (`Session.inTransaction`, optional), and a
  mark only that transaction has is checked before it commits.
- A restore isn't started on a `pg` older than 8.12, which sends two statements given as one:
  it says to update `pg`. Backups, and everything else, are as before there.
- A table or schema whose name holds a line end no longer puts a line of SQL into a backup
  through the file's comments.
- The tables a restore leaves where they are keep their privileges, and a partition of a table
  outside the schemas keeps the sequence it owns.
- One long statement (a row of megabytes) is read in time that grows with its length, not its
  square.
- A restore that finished is audited once, as restored, when the browser leaves as it ends.
- Read access runs, of someone's own SQL, only the statements that read (`SELECT`, `WITH`,
  `VALUES`, `TABLE`, `SHOW`, `EXPLAIN`, and `DESCRIBE` on MySQL), and refuses by name the
  functions known to reach past the database's rows. A read-only transaction doesn't hold a
  privileged login back: with a superuser's, `COPY … TO PROGRAM` ran a command on the database's
  server; with `root`, `INTO OUTFILE` wrote a file and `SET GLOBAL` changed the server. A write
  typed on a read connection is now refused with that message (403, `not-allowed`) before it
  reaches the database, where it was the database's own error (400).
- SQLite: someone's own SQL runs in a process of its own, killed at its time limit (a thread
  kept running, and kept the file locked), and when the server goes; a write killed part-way is
  undone before the next read. PRAGMAs that set a limit for the whole process
  (`hard_heap_limit`…) are refused. The first statement after a rest takes about 60 ms longer,
  the process starting; each one after, about 0.05 ms.
- PGlite: the site's session is put back while its queries still wait for the statement, never
  after, when what they had just set was taken for the statement's; and a setting of the site's
  own (`app.tenant`) that a statement set is put back too.
- An edit to a column named `constructor`, `__proto__` and the like is checked like any other,
  shown as it is in the grid, and kept in a JSON export.
