---
'@otwdesign/db-core': minor
'@otwdesign/db-ui': minor
---

A PostgreSQL connection opens any database on its server that its login may connect to. Click the database's name in the toolbar, or press ⌘K, to pick another one. Each database has its own tabs and history, and the address names it (`#main/archive`), so a reload comes back to it.

- `GET /api/databases?connection=` lists the databases. Every other endpoint takes a `database` (a query parameter for GET, a body field for POST), and the audit log records it.
- Each database gets its own pool, which opens on first use. The 8 used last stay open, and opening another closes the one used longest ago.
- `DB_ADMIN_<NAME>_DATABASES=one` (`databases: 'one'` in code) pins a connection to its URL's database.
- Drivers can offer the feature with `databases()` and `withDatabase(name)`. The PostgreSQL driver has both.
