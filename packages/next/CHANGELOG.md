# @otwdesign/db-next

## 1.4.1

### Patch Changes

- 5a696fb: - **A SQLite file opens from a built Next.js app.** The SQLite worker took part of its code from a function with `toString()`, and so got whatever the app's build had made of that function: Next.js left it without its name, and every request to a SQLite connection failed ("The SQLite worker failed: Function statements require a function name"). That code is now the worker's own text, which no build touches.
  - **Nobody can keep you out of db-next's sign-in.** Past eight wrong passwords waiting for their answer, every sign-in was turned away, the right password too: someone sending wrong ones without pause, or forms that never finished arriving, kept the owner out. Nothing is counted any more. A wrong password still waits half a second, each by itself, so a guesser gets as many tries as it opens connections: use a long, random password, and put a rate limit in front of `/db/sign-in` where your host has one.
- Updated dependencies [5a696fb]
  - @otwdesign/db-core@1.4.1

## 1.4.0

### Minor Changes

- 1ac09ac: `@otwdesign/db-next`: OTW DB in a Next.js app, on Vercel or anywhere, with one command.

  - `npx @otwdesign/db-next init`, in the app's directory, writes one route file
    (`app/db/[[...path]]/route.ts`) and installs the package. It finds `src/app`, a Pages Router
    app, JavaScript or TypeScript, npm, pnpm, yarn or bun, a monorepo's lockfile and next.config's
    `basePath`, and never writes over a file. It makes no password and writes none: it lists the
    variables to set, and the password is yours to choose and to keep out of git.
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
  - Wrong passwords are answered one at a time, half a second apart; past a few waiting, sign-ins
    are turned away for a moment. The session's key is made from the password with scrypt, so a
    cookie forged from a guess can't be tried faster than a sign-in. `init` takes no `--path` that
    climbs out of the app, and when the install fails says so and what's left to do, and can be
    run again.

### Patch Changes

- Updated dependencies [e2fa796]
  - @otwdesign/db-core@1.4.0
