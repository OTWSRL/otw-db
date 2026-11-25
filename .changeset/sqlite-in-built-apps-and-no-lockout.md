---
'@otwdesign/db-core': patch
'@otwdesign/db-next': patch
---

- **A SQLite file opens from a built Next.js app.** The SQLite worker took part of its code from a function with `toString()`, and so got whatever the app's build had made of that function: Next.js left it without its name, and every request to a SQLite connection failed ("The SQLite worker failed: Function statements require a function name"). That code is now the worker's own text, which no build touches.
- **Nobody can keep you out of db-next's sign-in.** Past eight wrong passwords waiting for their answer, every sign-in was turned away, the right password too: someone sending wrong ones without pause, or forms that never finished arriving, kept the owner out. Nothing is counted any more. A wrong password still waits half a second, each by itself, so a guesser gets as many tries as it opens connections: use a long, random password, and put a rate limit in front of `/db/sign-in` where your host has one.
