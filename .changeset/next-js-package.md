---
'@otwdesign/db-next': minor
---

`@otwdesign/db-next`: OTW DB in a Next.js app, on Vercel or anywhere, with one command.

- `npx @otwdesign/db-next init`, in the app's directory, writes one route file
  (`app/db/[[...path]]/route.ts`), adds a password to `.env.local` and installs the package. It
  finds `src/app`, a Pages Router app, JavaScript or TypeScript, npm, pnpm, yarn or bun, a
  monorepo's lockfile and next.config's `basePath`; it never writes over a file, and won't write
  a password where git would pick it up.
- `createDbRoute()` signs people in itself: anyone with `DB_ADMIN_PASSWORD` (16 characters at
  least), on a page of its own, with a signed session that needs nothing kept on the server.
- `DB_ADMIN_USERS`, emails separated by commas: the app's own signed-in users who get in with no
  password, and whose email the audit log has. An app on Supabase Auth has its session read with
  no code; any other sign-in says who is signed in with `createDbRoute({ user })`.
- With no `DB_ADMIN_<NAME>_URL`, it opens the app's own database, read-only, by the names Neon,
  Supabase and Vercel Postgres give it, the one that doesn't go through a transaction pooler
  first.
- It brings `pg` and `pg-cursor` where Next's file tracing finds them. Mounted by hand as the
  guide showed, a Vercel function had no driver.
