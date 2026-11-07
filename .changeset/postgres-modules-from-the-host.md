---
'@otwdesign/db-core': minor
'@otwdesign/plugin-db': patch
---

PostgreSQL connections work in a CMS site installed with pnpm. pnpm keeps the plugin's `pg` and `pg-cursor` beside the plugin, not in the site's root, so db-core couldn't import them from where the site's bundle runs. `postgresDriver(url, { modules })` and `openDriver(connection, { postgres })` now take them from the host, and the plugin hands over its own. A driver that failed to load is tried again on the next request.
