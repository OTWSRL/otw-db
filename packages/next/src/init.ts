import { execFileSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MIN_PASSWORD } from './session.ts'

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
  /** next.config sets a `basePath` that isn't a plain path, so it wasn't taken. */
  basePathUnread: boolean
  /** Its middleware (or proxy, as Next 16 calls it), relative to the app; null without one. */
  middleware: string | null
  /**
   * Files that are there and weren't read: not a file, or larger than any such file is. What
   * they'd have said isn't known, which isn't the same as their saying nothing.
   */
  unread: string[]
  /** DB_ADMIN_PASSWORD is set in `.env`, a file apps usually keep in git. */
  passwordInDotEnv: boolean
  /** The names already set in `.env.local` and `.env`. */
  envNames: ReadonlySet<string>
  /** The tool's own names those files mention at all, set or in a comment an earlier run left. */
  envMentions: ReadonlySet<string>
  /** The app uses Supabase: its packages, or its address in the env. */
  supabase: boolean
  /**
   * The Node major package.json holds the app to (`20`, `20.x`, `^18.17`), when it holds it to
   * one: the number, never the text, which is someone's and gets printed.
   */
  nodeMajor: number | null
  /** `@otwdesign/db-next` is a dependency already. */
  installed: boolean
}

export interface InitFlags {
  /** Where the tool goes, such as `/db` (the default) or `/admin/db`. */
  path?: string
  /** Install nothing: the files only. */
  install?: boolean
}

/** What `init` would do: files to write, a command, and what to say and leave to the person. */
export interface InitPlan {
  /** Why nothing can be done; when set, the rest is empty. */
  refused: string | null
  files: { path: string; content: string }[]
  /**
   * The variables still to set, as lines for the person to add to their environment: `init`
   * writes none of them. The password is theirs to choose and to place, and a file in a folder
   * someone else may have prepared is no place for a tool to put a secret.
   */
  env: string[]
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

/** Whether `path` is `root` or inside it. */
function within(root: string, path: string): boolean {
  const from = relative(root, path)
  return from === '' || (!from.startsWith('..') && !isAbsolute(from))
}

/** More than any file read here holds: a package.json, a next.config, an env file. */
const MOST = 1024 * 1024

/**
 * A file's text, without a byte-order mark; null when it isn't there, isn't a file (a pipe of
 * that name would be waited on for ever) or is larger than such files are (read whole, it is a
 * wait as long as its author likes).
 */
function read(path: string): string | null {
  try {
    const file = statSync(path)
    if (!file.isFile() || file.size > MOST) return null
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
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

/** Whether `path` is a folder, or leads to one. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether files can be made in the folder `path`. */
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The names in the folder `path`; null when it can't be listed. */
function namesIn(path: string): string[] | null {
  try {
    return readdirSync(path)
  } catch {
    return null
  }
}

/** Whether there is anything at `path`, a link that leads nowhere included. */
function entry(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** What a file of JSON holds, when it holds an object: nothing else has anything to read. */
function objectIn(text: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A path as `--path` and a route take it: short, segments of plain characters, none of them dots alone. */
function plainPath(path: string): boolean {
  // Of a length paths have: it's written into a file and printed, as often as it's long.
  if (path.length > 200) return false
  return PATH.test(path) && !path.split('/').some((segment) => /^\.+$/.test(segment))
}

/**
 * `basePath` as next.config sets it: the path, an empty string when it sets none, null when what
 * the file says of it can't be taken for one plain path. It is taken only in the one shape that
 * needs no reading of JavaScript: the word once in the file, as a key with a short quoted value,
 * on a line with no comment before it and nothing joined on after it. Anything else (a variable, two mentions, a value built
 * from parts) gets a note and no guess: a wrong address is worse than one to fill in. A block
 * comment over several lines isn't seen for what it is; the note says where the address goes.
 */
function basePathIn(config: string): string | null {
  const first = config.indexOf('basePath')
  if (first < 0) return ''
  if (config.indexOf('basePath', first + 1) >= 0) return null
  const before = config.slice(config.lastIndexOf('\n', first) + 1, first)
  const set = /^basePath\s*:\s*(['"`])([^'"`\n\\$]{0,201})\1(?=[ \t]*(?:[,}\r\n]|$))/.exec(
    config.slice(first, first + 300),
  )
  if (!set || /\/\/|\/\*|^\s*\*/.test(before)) return null
  const value = set[2]!.replace(/\/$/, '')
  return value === '' || plainPath(value) ? value : null
}

/**
 * The Node major `engines.node` holds an app to, when it names one version line: `20`, `20.x`,
 * `^18.17`. A range open upwards (`>=18`) names none.
 */
function pinnedMajor(range: unknown): number | null {
  // Text only: package.json is someone's file.
  if (typeof range !== 'string') return null
  const pinned = /^[\^~=v]?\s*(\d{1,4})(?:\.(?:x|\*|\d+))*$/.exec(range.trim())
  return pinned ? Number(pinned[1]) : null
}

const CONFIGS = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']
/** The env files Next.js reads, on a machine and in a build. */
const ENV_FILES = [
  '.env.local',
  '.env',
  '.env.development.local',
  '.env.development',
  '.env.production.local',
  '.env.production',
]

/** Looks at the app in `dir`. */
export function detect(dir: string): Detected {
  const root = resolve(dir)
  const manifest = objectIn(read(join(root, 'package.json'))) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    engines?: { node?: string }
    packageManager?: unknown
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const has = (path: string) => existsSync(join(root, path))
  const src = has('src/app') || has('src/pages') ? 'src' : ''
  const config = CONFIGS.map((file) => read(join(root, file))).find((text) => text !== null)
  const middleware =
    ['middleware.ts', 'middleware.js', 'proxy.ts', 'proxy.js']
      .flatMap((file) => [file, join('src', file)])
      .find(has) ?? null
  const basePath = basePathIn(config ?? '')
  const envFiles = ENV_FILES.map((file) => read(join(root, file)))
  const unread = ['package.json', ...CONFIGS, ...ENV_FILES].filter(
    (file) => entry(join(root, file)) && read(join(root, file)) === null,
  )
  const names = new Set(envFiles.flatMap(envNames))
  const mentions = new Set(envFiles.flatMap((text) => text?.match(/DB_ADMIN_[A-Z0-9_]+/g) ?? []))
  return {
    dir: root,
    next: 'next' in dependencies,
    src,
    typescript: has('tsconfig.json'),
    manager: managerOf(root, manifest.packageManager),
    nextBasePath: basePath ?? '',
    basePathUnread: basePath === null,
    unread,
    middleware,
    passwordInDotEnv: envNames(read(join(root, '.env'))).includes('DB_ADMIN_PASSWORD'),
    envNames: names,
    envMentions: mentions,
    supabase:
      '@supabase/supabase-js' in dependencies ||
      '@supabase/ssr' in dependencies ||
      names.has('NEXT_PUBLIC_SUPABASE_URL') ||
      names.has('SUPABASE_URL'),
    nodeMajor: pinnedMajor(manifest.engines?.node),
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

/** What to do in the app `detect` found. Writes nothing. */
export function plan(detected: Detected, flags: InitFlags = {}): InitPlan {
  const nothing = { files: [], env: [], install: null, notes: [], url: '' }
  if (detected.unread.includes('package.json')) {
    return {
      ...nothing,
      refused: 'package.json couldn’t be read: it isn’t a file, or is larger than such a file is.',
    }
  }
  if (!detected.next) {
    return {
      ...nothing,
      refused:
        'This isn’t a Next.js app: package.json has no "next" among its dependencies. Run it in the app’s own directory.',
    }
  }
  const path = (flags.path ?? '/db').replace(/\/+$/, '')
  // A segment of dots alone is this folder, or the one above it: out of the app, by two of them.
  if (!plainPath(path)) {
    return {
      ...nothing,
      refused: `--path is a path such as /db or /admin/db: segments of letters, digits, . _ ~ and -, not "${flags.path}".`,
    }
  }
  const app = join(detected.src, 'app')
  const route = join(app, ...path.split('/').filter(Boolean))
  const pages = join(detected.src, 'pages', ...path.split('/').filter(Boolean))
  // As the browser has it: next.config's basePath comes before every route of the app.
  const basePath = `${detected.nextBasePath.replace(/\/+$/, '')}${path}`
  const file = join(route, '[[...path]]', detected.typescript ? 'route.ts' : 'route.js')
  // An earlier run's own route, as it wrote it: this one goes on from there (an install that
  // failed, a password still to set) and writes over nothing.
  const written =
    read(join(detected.dir, file)) === routeFile(basePath) &&
    namesIn(join(detected.dir, route))?.length === 1
  const taken = written
    ? undefined
    : [
        route,
        pages,
        ...['tsx', 'ts', 'jsx', 'js'].map((extension) => `${pages}.${extension}`),
      ].find((candidate) => existsSync(join(detected.dir, candidate)))
  // Through a link, the route would be written outside the app, where the link leads.
  let inside = detected.dir
  for (const segment of file.split(sep).slice(0, -1)) {
    const next = join(inside, segment)
    if (!entry(next)) break
    inside = next
  }
  if (inside !== detected.dir && !isDirectory(inside)) {
    return {
      ...nothing,
      refused: `${relative(detected.dir, inside)} isn’t a folder: the route can’t be written under it.`,
    }
  }
  let leadsOut: boolean
  try {
    leadsOut = !within(realpathSync(detected.dir), realpathSync(inside))
  } catch {
    // A link that leads nowhere: nothing can be made in it either.
    leadsOut = true
  }
  if (leadsOut) {
    return {
      ...nothing,
      refused: `${relative(detected.dir, inside)} is a link to somewhere outside this app: the route would be written there. Run it in the app the link leads to.`,
    }
  }
  if (!written && !taken && !writable(inside)) {
    // Said now, as a dry run would have to: the run itself would stop here.
    return {
      ...nothing,
      refused: `${relative(detected.dir, inside) || 'This folder'} can’t be written in: the route can’t be made there. Check its permissions.`,
    }
  }
  if (taken) {
    return {
      ...nothing,
      refused: `${taken} is there already: the app has something at ${path}. Choose another place with --path, such as --path /admin/db.`,
    }
  }
  const notes: string[] = []

  const lines: string[] = []
  if (!detected.envNames.has('DB_ADMIN_PASSWORD')) {
    lines.push(
      `# OTW DB (${basePath}). A password of your own, ${MIN_PASSWORD} characters at least: whoever has it can open the database.`,
      'DB_ADMIN_PASSWORD=',
    )
    notes.push(
      `Choose a strong password of your own and set it as DB_ADMIN_PASSWORD: ${MIN_PASSWORD} characters at least, from your password manager or a command such as openssl rand -base64 32. It’s set in none of the app’s env files; until it’s set somewhere, nobody signs in with a password. Keep it out of git: in .env.local on your machine (git check-ignore .env.local names the file when git leaves it alone), in your host’s settings where the app runs.`,
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

  const unread = detected.unread.filter((file) => file !== 'package.json')
  if (unread.length) {
    notes.push(
      `Not read, so what ${unread.length > 1 ? 'they set' : 'it sets'} isn’t counted above: ${unread.join(', ')} (not a file, or larger than such a file is). Check there for DB_ADMIN_PASSWORD and the database’s address yourself.`,
    )
  }
  if (detected.passwordInDotEnv) {
    notes.push(
      'DB_ADMIN_PASSWORD is set in .env, a file apps usually keep in git. If git has it, whoever can read the repository has the password: move it to .env.local (or your host’s settings) and choose a new one.',
    )
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
  if (detected.nodeMajor !== null && detected.nodeMajor < 22) {
    notes.push(
      `package.json asks for Node ${detected.nodeMajor}; OTW DB needs 22.18 or newer. On Vercel, set the project’s Node.js version to 22 or 24.`,
    )
  }
  if (detected.basePathUnread) {
    notes.push(
      `next.config mentions basePath in a way this couldn’t read as one plain path, so the route was written without it. If the app is served under one, name the whole address in the route file: createDbRoute({ basePath: '<your basePath>${path}' }).`,
    )
  }
  notes.push(
    'On your host, set the same variables. On Vercel: vercel env add DB_ADMIN_PASSWORD (and DB_ADMIN_USERS, DB_ADMIN_MAIN_URL where you use them), then deploy.',
  )

  const add = { npm: 'install', pnpm: 'add', yarn: 'add', bun: 'add' }[detected.manager]
  return {
    refused: null,
    files: written ? [] : [{ path: file, content: routeFile(basePath) }],
    env: lines,
    install:
      flags.install === false || detected.installed
        ? null
        : { command: detected.manager, args: [add, '@otwdesign/db-next'] },
    notes,
    url: basePath,
  }
}

/** How `apply` went. */
export interface InitOutcome {
  /** Why the package wasn't installed, when installing it was tried and failed. */
  installFailed: string | null
}

/**
 * Does what the plan says, in the app's directory. `run` installs; a test stands in for it. An
 * install that fails (no network, a registry that says no) is reported, not thrown: the files
 * are written by then, and what's left to do must still be said.
 */
export function apply(
  detected: Detected,
  planned: InitPlan,
  run: (command: string, args: string[], cwd: string) => void = (command, args, cwd) =>
    // On Windows the package managers are .cmd files, which only a shell runs. The command and
    // its arguments are this file's own words, never what someone typed.
    void execFileSync(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    }),
): InitOutcome {
  if (planned.refused) throw new Error(planned.refused)
  for (const file of planned.files) {
    const target = join(detected.dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    // Never over what's there: `plan` refused if it was, and this holds if it appeared since.
    writeFileSync(target, file.content, { flag: 'wx' })
  }
  if (planned.install) {
    try {
      run(planned.install.command, planned.install.args, detected.dir)
    } catch (error) {
      return { installFailed: (error as Error).message.split('\n')[0] ?? 'it failed' }
    }
  }
  return { installFailed: null }
}

/** What was done, or would be, for the terminal. */
export function report(
  detected: Detected,
  planned: InitPlan,
  dryRun: boolean,
  outcome: InitOutcome = { installFailed: null },
): string {
  if (planned.refused) return `${planned.refused}\n`
  const did = dryRun ? 'Would' : 'Did'
  const out = [`OTW DB for this Next.js app, at ${planned.url}:`, '']
  for (const file of planned.files) out.push(`  ${did} write ${file.path}`)
  if (planned.install) {
    const command = `${planned.install.command} ${planned.install.args.join(' ')}`
    out.push(
      outcome.installFailed
        ? `  Couldn’t run ${command} (${outcome.installFailed}). Run it yourself, in this directory.`
        : `  ${did} run ${command}`,
    )
  }
  if (planned.env.length) {
    out.push(
      '',
      '  Yours to add to the app’s environment (.env.local on your machine, your host’s settings):',
      ...planned.env.map((line) => `      ${line}`),
    )
  }
  out.push('', ...planned.notes.flatMap((note) => [`- ${note}`, '']))
  out.push(
    dryRun
      ? 'Nothing was changed: run it again without --dry-run.'
      : `${planned.env.includes('DB_ADMIN_PASSWORD=') ? 'Set DB_ADMIN_PASSWORD, start' : 'Start'} the app and open ${planned.url}.`,
  )
  // Text and line ends only. Nothing above quotes the app's files; this holds if a later line does.
  return `${out.join('\n')}\n`.replace(/[^\n\P{Cc}]/gu, '')
}
