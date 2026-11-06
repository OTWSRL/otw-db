# @otwdesign/db

OTW DB on its own: a database manager in your browser, with every driver included.

```sh
DB_ADMIN_MAIN_URL=postgres://user:password@localhost:5432/shop npx @otwdesign/db
```

It listens on 127.0.0.1:4010 and prints a link with a one-time token that signs your browser in.
Connections come from the environment (and `.env`): `DB_ADMIN_<NAME>_URL` (postgres://, mysql://,
mariadb:// or sqlite:/path/to/file.db), `_ACCESS` (`read`, the default, or `write`), `_LABEL` and
`_TAG` (`local`, `development`, `testing`, `staging` or `production`).

The whole guide: [github.com/OTWSRL/otw-db](https://github.com/OTWSRL/otw-db#readme).
