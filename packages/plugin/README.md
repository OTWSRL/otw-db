# @otwdesign/plugin-db

Database for [OTW CMS](https://github.com/OTWSRL/otw-cms): browse, query and edit the site's
database, and any other you connect, in the admin.

```sh
npm install @otwdesign/plugin-db
```

Add it to `cms.config.json`'s `plugins`. Administrators get Database in the admin menu (the
`db.manage` capability). The site's own database is read-only unless `DB_ADMIN_SITE_ACCESS=write`;
other databases come from `DB_ADMIN_<NAME>_URL`. On an embedded database (PGlite), a heavy statement
holds the whole site until it finishes, and the screen says so.

The whole guide: [github.com/OTWSRL/otw-db](https://github.com/OTWSRL/otw-db#readme).
