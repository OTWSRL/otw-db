# @otwdesign/db-next

OTW DB in a Next.js app, on Vercel or anywhere: a database manager at `/db`, with a sign-in of its
own. In the app's directory:

```sh
npx @otwdesign/db-next init
```

It writes one route file, adds a password to `.env.local`, and installs this package. It never
writes over a file; `--dry-run` says what it would do, `--path /admin/db` puts it elsewhere.

```ts
// app/db/[[...path]]/route.ts
import { createDbRoute } from '@otwdesign/db-next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const { GET, POST } = createDbRoute()
```

```dotenv
DB_ADMIN_PASSWORD=…                              # whoever has it gets in; 16 characters at least
DB_ADMIN_USERS=you@example.com,ana@example.com   # the app's signed-in users who need no password
DB_ADMIN_MAIN_URL=postgres://…                   # or the app's own DATABASE_URL, read-only
```

Set the same variables on your host (`vercel env add DB_ADMIN_PASSWORD`), and open `/db`.

## Who gets in

- **The password:** `/db/sign-in` asks for it and sets a session for 12 hours. Changing the
  password ends every session. One under 16 characters is refused.
- **The app's own users:** those listed in `DB_ADMIN_USERS`, by email (or id), get in without the
  password once they're signed in to the app. The audit log has who it was. With the list set and
  no password, nobody else gets in.
  - An app on **Supabase Auth** needs no code: the session `@supabase/ssr` keeps is read, and
    Supabase is asked whose it is. Only a confirmed email counts. List people who have an
    account, and keep Confirm email on in Supabase.
  - Any other sign-in says who is signed in:

    ```ts
    import { auth } from '@/auth' // Auth.js, Clerk, your own

    export const { GET, POST } = createDbRoute({
      user: async () => (await auth())?.user?.email,
    })
    ```

- **Your own rule,** instead of both: `createDbRoute({ authorize, signInUrl: '/login' })`, where
  `authorize(request)` returns `{ id }` or `null`.

Middleware that signs people in on every route must leave `/db` out of its matcher.

## Which databases

`DB_ADMIN_<NAME>_URL` (with `_ACCESS`, `_LABEL`, `_TAG`), as in the
[whole guide](https://github.com/OTWSRL/otw-db#readme). With none set, the app's own database,
read-only unless `DB_ADMIN_APP_ACCESS=write`: `DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`,
`DATABASE_URL` or `POSTGRES_URL`, the first that's set. The tool keeps a session, which a
transaction pooler doesn't, so the address that goes round the pooler comes first.

On **Supabase**, an app that only uses Supabase's API holds no address of its database: copy the
Session pooler connection string from Supabase's Connect dialog into `DB_ADMIN_MAIN_URL`.

## On Vercel

This package brings `pg` and `pg-cursor` and imports them where Next's file tracing sees them, so
they're in the deployed function. MySQL and MariaDB work where the whole of `node_modules` is
deployed (`next start` on a server), not yet in a Vercel function.

`createDbRoute(options)` also takes `basePath` (with next.config's `basePath` in front, as the
browser has it), `connections`, and what `createDbAdmin` takes: `audit`, `limits`, `origins`,
`backups`.
