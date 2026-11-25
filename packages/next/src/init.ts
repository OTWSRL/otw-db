import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/*
 * `otw-db-next init`: OTW DB added to a Next.js app that's already there. What it finds
 * (`detect`), what it would do about it (`plan`) and doing it (`apply`) are apart, so the first
 * two can be looked at without anything being written.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** What `init` found in the app's directory. */
export interface Detected {
  /** The app's directory, absolute. */
  dir: string
  /** `next` is among its dependencies. */
  next: boolean
  /** `src` when the app keeps `app/` or `pages/` there, else empty. */
  src: '' | 'src'
  typescript: boolean
  manager: PackageManager
  /** `basePath` from next.config, such as `/docs`; empty without one. */
  nextBasePath: string
  /** Its middleware (or proxy, as Next 16 calls it), relative to the app; null without one. */
  middleware: string | null
  /** `.gitignore` keeps `.env.local` out of git. */
  envIgnored: boolean
  /** The names already set in `.env.local` and `.env`. */
  envNames: ReadonlySet<string>
  /** The tool's own names those files mention at all, set or in a comment an earlier run left. */
  envMentions: ReadonlySet<string>
  /** The app uses Supabase: its packages, or its address in the env. */
  supabase: boolean
  /** `engines.node` in package.json, if it says. */
  nodeEngine: string | null
  /** `@otwdesign/db-next` is a dependency already. */
  installed: boolean
}

export interface InitFlags {
  /** Where the tool goes, such as `/db` (the default) or `/admin/db`. */
  path?: string
  /** Install nothing: the files only. */
  install?: boolean
  /** For a test: the password to write, where one is made at random. */
  password?: string
}

/** What `init` would do: files to write, lines for `.env.local`, a command, and what to say. */
export interface InitPlan {
  /** Why nothing can be done; when set, the rest is empty. */
  refused: string | null
  files: { path: string; content: string }[]
  /** Lines to add to `.env.local`, and the file; null when there's nothing to add. */
  env: { path: string; lines: string[] } | null
  /** The command that installs the package; null with `--no-install`, or when it's there. */
  install: { command: string; args: string[] } | null
  /** What the person should know, or do next. */
  notes: string[]
  /** Where the tool will be, as the browser has it. */
  url: string
}

const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/
/** The app's own PostgreSQL, by the names `appConnections()` reads. */
const OWN = ['DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL', 'POSTGRES_URL']

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The package manager, by the nearest lockfile on the way up (a monorepo keeps it at its root). */
function managerOf(dir: string, packageManager: unknown): PackageManager {
  const locks: [string, PackageManager][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ]
  for (let at = dir; ; at = dirname(at)) {
    for (const [file, manager] of locks) if (existsSync(join(at, file))) return manager
    if (dirname(at) === at) break
  }
  const named = typeof packageManager === 'string' ? packageManager.split('@')[0] : ''
  return named === 'pnpm' || named === 'yarn' || named === 'bun' ? named : 'npm'
}

/** The names a dotenv file sets, comments and blank lines aside. */
function envNames(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((name): name is string => !!name)
}

/** Whether `.gitignore` keeps `.env.local` out: by name, or by the patterns Next's own starter has. */
function ignoresEnvLocal(gitignore: string | null): boolean {
  const patterns = (gitignore ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^\//, ''))
    .filter((line) => line && !line.startsWith('#'))
  return patterns.some((p) =>
    ['.env.local', '.env*', '.env*.local', '.env.*', '*.local'].includes(p),
  )
}

/** Looks at the app in `dir`. */
export function detect(dir: string): Detected {
  const root = resolve(dir)
  const manifest = JSON.parse(read(join(root, 'package.json')) ?? '{}') as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    engines?: { node?: string }
    packageManager?: unknown
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const has = (path: string) => existsSync(join(root, path))
  const src = has('src/app') || has('src/pages') ? 'src' : ''
  const config = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']
    .map((file) => read(join(root, file)))
    .find((text) => text !== null)
  const middleware =
    ['middleware.ts', 'middleware.js', 'proxy.ts', 'proxy.js']
      .flatMap((file) => [file, join('src', file)])
      .find(has) ?? null
  const envFiles = [read(join(root, '.env.local')), read(join(root, '.env'))]
  const names = new Set(envFiles.flatMap(envNames))
  const mentions = new Set(envFiles.flatMap((text) => text?.match(/DB_ADMIN_[A-Z0-9_]+/g) ?? []))
  return {
    dir: root,
    next: 'next' in dependencies,
    src,
    typescript: has('tsconfig.json'),
    manager: managerOf(root, manifest.packageManager),
    nextBasePath: /\bbasePath\s*:\s*['"`](\/[^'"`]*)['"`]/.exec(config ?? '')?.[1] ?? '',
    middleware,
    envIgnored: ignoresEnvLocal(read(join(root, '.gitignore'))),
    envNames: names,
    envMentions: mentions,
    supabase:
      '@supabase/supabase-js' in dependencies ||
      '@supabase/ssr' in dependencies ||
      names.has('NEXT_PUBLIC_SUPABASE_URL') ||
      names.has('SUPABASE_URL'),
    nodeEngine: manifest.engines?.node ?? null,
    installed: '@otwdesign/db-next' in dependencies,
  }
}

/**
 * The route file: all of the tool's setup an app holds. The comments are for whoever opens it
 * months later and wonders where the password and the databases come from.
 */
export function routeFile(basePath: string): string {
  const options = basePath === '/db' ? '' : `{ basePath: '${basePath}' }`
  return `import { createDbRoute } from '@otwdesign/db-next'

// OTW DB at ${basePath}: its page, its files and its API, all in this one route.
// Who gets in: anyone with DB_ADMIN_PASSWORD, and the app's signed-in users listed in
// DB_ADMIN_USERS (their emails, comma-separated), who need no password.
// Which databases: DB_ADMIN_<NAME>_URL, or the app's own (DATABASE_URL), read-only.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST } = createDbRoute(${options})
`
}

/**
 * Whether `engines.node` holds the app to a Node before 22, which the tool can't run on: `20`,
 * `20.x`, `^18.17`. A range open upwards (`>=18`) doesn't.
 */
function nodeTooOld(range: string | null): boolean {
  const pinned = /^\s*[\^~=v]?\s*(\d+)(?:\.(?:x|\*|\d+))*\s*$/.exec(range ?? '')
  return pinned !== null && Number(pinned[1]) < 22
}

/** What to do in the app `detect` found. Writes nothing. */
export function plan(detected: Detected, flags: InitFlags = {}): InitPlan {
  const nothing = { files: [], env: null, install: null, notes: [], url: '' }
  if (!detected.next) {
    return {
      ...nothing,
      refused:
        'This isn’t a Next.js app: package.json has no "next" among its dependencies. Run it in the app’s own directory.',
    }
  }
  const path = (flags.path ?? '/db').replace(/\/+$/, '')
  if (!PATH.test(path)) {
    return {
      ...nothing,
      refused: `--path is a path such as /db or /admin/db: segments of letters, digits, . _ ~ and -, not "${flags.path}".`,
    }
  }
  const app = join(detected.src, 'app')
  const route = join(app, ...path.split('/').filter(Boolean))
  const pages = join(detected.src, 'pages', ...path.split('/').filter(Boolean))
  const taken = [
    route,
    pages,
    ...['tsx', 'ts', 'jsx', 'js'].map((extension) => `${pages}.${extension}`),
  ].find((candidate) => existsSync(join(detected.dir, candidate)))
  if (taken) {
    return {
      ...nothing,
      refused: `${taken} is there already: the app has something at ${path}. Choose another place with --path, such as --path /admin/db.`,
    }
  }
  // As the browser has it: next.config's basePath comes before every route of the app.
  const basePath = `${detected.nextBasePath.replace(/\/+$/, '')}${path}`
  const file = join(route, '[[...path]]', detected.typescript ? 'route.ts' : 'route.js')
  const notes: string[] = []

  const lines: string[] = []
  const password = flags.password ?? randomBytes(24).toString('base64url')
  if (!detected.envNames.has('DB_ADMIN_PASSWORD')) {
    lines.push(
      `# OTW DB (${basePath}). Whoever has this password can open the database.`,
      `DB_ADMIN_PASSWORD=${password}`,
    )
  }
  if (!detected.envMentions.has('DB_ADMIN_USERS')) {
    lines.push(
      '# The app’s signed-in users who get in without it: their emails, comma-separated.',
      '# DB_ADMIN_USERS=you@example.com,colleague@example.com',
    )
  }
  const named = [...detected.envNames].some((name) => /^DB_ADMIN_[A-Z0-9_]+_URL$/.test(name))
  const own = OWN.find((name) => detected.envNames.has(name))
  if (!named && !detected.envMentions.has('DB_ADMIN_MAIN_URL')) {
    lines.push(
      ...(own
        ? [
            `# The database it opens: the app’s own (${own}), read-only. To choose another, or more:`,
            '# DB_ADMIN_MAIN_URL=postgres://user:password@host:5432/database',
          ]
        : [
            '# The database it opens, such as postgres://user:password@host:5432/database:',
            'DB_ADMIN_MAIN_URL=',
          ]),
      '# DB_ADMIN_MAIN_ACCESS=write   # read, unless you say so',
    )
  }
  let env: InitPlan['env'] = lines.length ? { path: '.env.local', lines } : null
  if (env && !detected.envIgnored) {
    // A password written where git would pick it up is a password published.
    notes.push(
      `.gitignore doesn’t keep .env.local out of git, so nothing was written there. Add these to your environment yourself:\n${lines
        .map((line) => `    ${line}`)
        .join('\n')}`,
    )
    env = null
  }

  if (!named && !own) {
    notes.push(
      detected.supabase
        ? 'This app talks to Supabase through its API, so it holds no address of the database itself. In Supabase, open Connect, copy the “Session pooler” connection string, and set it as DB_ADMIN_MAIN_URL. (Not “Direct connection”: Vercel can’t reach it. Not “Transaction pooler”: the tool keeps a session.)'
        : 'No database address was found. Set DB_ADMIN_MAIN_URL to the database to open, such as postgres://user:password@host:5432/database.',
    )
  }
  if (detected.middleware) {
    notes.push(
      `This app has ${detected.middleware}. If it signs people in on every route, or redirects them, leave ${basePath} out of its matcher: the tool has its own sign-in, and its API must not be answered with a login page. For example: matcher: ['/((?!${basePath.slice(1)}|_next/static|_next/image|favicon.ico).*)']`,
    )
  }
  if (detected.supabase) {
    notes.push(
      'On Supabase Auth, the users you list in DB_ADMIN_USERS are recognised by their session, with no code. List only people who already have an account, and keep “Confirm email” on in Supabase: an address nobody has registered yet could otherwise be signed up by anyone.',
    )
  } else {
    notes.push(
      'To let your own signed-in users in without the password, list their emails in DB_ADMIN_USERS and tell the route who is signed in: createDbRoute({ user: async () => (await auth())?.user?.email }).',
    )
  }
  if (nodeTooOld(detected.nodeEngine)) {
    notes.push(
      `package.json asks for Node ${detected.nodeEngine}; OTW DB needs 22.18 or newer. On Vercel, set the project’s Node.js version to 22 or 24.`,
    )
  }
  notes.push(
    'On your host, set the same variables. On Vercel: vercel env add DB_ADMIN_PASSWORD (and DB_ADMIN_USERS, DB_ADMIN_MAIN_URL where you use them), then deploy.',
  )

  const add = { npm: 'install', pnpm: 'add', yarn: 'add', bun: 'add' }[detected.manager]
  return {
    refused: null,
    files: [{ path: file, content: routeFile(basePath) }],
    env,
    install:
      flags.install === false || detected.installed
        ? null
        : { command: detected.manager, args: [add, '@otwdesign/db-next'] },
    notes,
    url: basePath,
  }
}

/** Does what the plan says, in the app's directory. `run` installs; a test stands in for it. */
export function apply(
  detected: Detected,
  planned: InitPlan,
  run: (command: string, args: string[], cwd: string) => void = (command, args, cwd) =>
    void execFileSync(command, args, { cwd, stdio: 'inherit' }),
): void {
  if (planned.refused) throw new Error(planned.refused)
  for (const file of planned.files) {
    const target = join(detected.dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    // Never over what's there: `plan` refused if it was, and this holds if it appeared since.
    writeFileSync(target, file.content, { flag: 'wx' })
  }
  if (planned.env) {
    const target = join(detected.dir, planned.env.path)
    const before = read(target) ?? ''
    // After what's there, a blank line between.
    const joint = !before ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(target, `${before}${joint}${planned.env.lines.join('\n')}\n`)
  }
  if (planned.install) run(planned.install.command, planned.install.args, detected.dir)
}

/** What was done, or would be, for the terminal. */
export function report(detected: Detected, planned: InitPlan, dryRun: boolean): string {
  if (planned.refused) return `${planned.refused}\n`
  const did = dryRun ? 'Would' : 'Did'
  const out = [`OTW DB for this Next.js app, at ${planned.url}:`, '']
  for (const file of planned.files) out.push(`  ${did} write ${file.path}`)
  if (planned.env) {
    out.push(`  ${did} add to ${relative(detected.dir, join(detected.dir, planned.env.path))}:`)
    for (const line of planned.env.lines.filter((l) => !l.startsWith('#'))) {
      out.push(
        `      ${line.replace(/^(DB_ADMIN_PASSWORD=).+$/, '$1(a new password, 32 characters)')}`,
      )
    }
  }
  if (planned.install) {
    out.push(`  ${did} run ${planned.install.command} ${planned.install.args.join(' ')}`)
  }
  out.push('', ...planned.notes.flatMap((note) => [`- ${note}`, '']))
  out.push(
    dryRun
      ? 'Nothing was changed: run it again without --dry-run.'
      : `Start the app and open ${planned.url}.`,
  )
  return `${out.join('\n')}\n`
}
