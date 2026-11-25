import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { apply, detect, plan, report, routeFile } from '../src/init.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An app's directory, with the files given: a Next.js app with a lockfile unless told otherwise. */
function app(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'otw-db-init-'))
  made.push(dir)
  const all = {
    'package.json': JSON.stringify({ dependencies: { next: '^16.0.0', react: '^19.0.0' } }),
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    '.gitignore': 'node_modules\n.env*\n',
    'app/page.tsx': 'export default () => null\n',
    ...files,
  }
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const readIn = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')
const PASSWORD = 'a-password-made-for-the-test-123'

describe('otw-db-next init', () => {
  it('writes one route file and the password, and installs the package', () => {
    const dir = app()
    const detected = detect(dir)
    const planned = plan(detected, { password: PASSWORD })
    expect(planned.refused).toBeNull()
    expect(planned.files.map((f) => f.path)).toEqual(['app/db/[[...path]]/route.ts'])
    expect(planned.install).toEqual({ command: 'npm', args: ['install', '@otwdesign/db-next'] })
    const run = vi.fn()
    apply(detected, planned, run)
    expect(readIn(dir, 'app/db/[[...path]]/route.ts')).toBe(routeFile('/db'))
    expect(readIn(dir, '.env.local')).toBe(
      [
        '# OTW DB (/db). Whoever has this password can open the database.',
        `DB_ADMIN_PASSWORD=${PASSWORD}`,
        '# The app’s signed-in users who get in without it: their emails, comma-separated.',
        '# DB_ADMIN_USERS=you@example.com,colleague@example.com',
        '# The database it opens, such as postgres://user:password@host:5432/database:',
        'DB_ADMIN_MAIN_URL=',
        '# DB_ADMIN_MAIN_ACCESS=write   # read, unless you say so',
        '',
      ].join('\n'),
    )
    expect(run).toHaveBeenCalledWith('npm', ['install', '@otwdesign/db-next'], detected.dir)
  })

  it('writes the route the example app has', () => {
    const example = new URL('../../../examples/next/app/db/[[...path]]/route.ts', import.meta.url)
    expect(routeFile('/db')).toBe(readFileSync(example, 'utf8'))
    expect(routeFile('/db')).toContain('export const { GET, POST } = createDbRoute()')
    expect(routeFile('/admin/db')).toContain("createDbRoute({ basePath: '/admin/db' })")
  })

  it('makes a password of its own, long and different each time', () => {
    const detected = detect(app())
    const password = (run: ReturnType<typeof plan>) =>
      /^DB_ADMIN_PASSWORD=(.+)$/m.exec(run.env!.lines.join('\n'))![1]!
    const [one, two] = [password(plan(detected)), password(plan(detected))]
    expect(one).toMatch(/^[\w-]{32}$/)
    expect(one).not.toBe(two)
  })

  it.each([
    ['src/app', { 'src/app/page.tsx': '', 'app/page.tsx': '' }, 'src/app/db/[[...path]]/route.ts'],
    ['a Pages Router app', { 'pages/index.tsx': '' }, 'app/db/[[...path]]/route.ts'],
    ['src/pages', { 'src/pages/index.tsx': '' }, 'src/app/db/[[...path]]/route.ts'],
  ])('puts the route where the app keeps its own: %s', (_, files, expected) => {
    const dir = app(files)
    if (!('app/page.tsx' in files) || files['app/page.tsx'] === '') {
      rmSync(join(dir, 'app'), { recursive: true, force: true })
    }
    expect(plan(detect(dir)).files[0]!.path).toBe(expected)
  })

  it('writes JavaScript for an app with no tsconfig', () => {
    const dir = app()
    rmSync(join(dir, 'tsconfig.json'))
    expect(plan(detect(dir)).files[0]!.path).toBe('app/db/[[...path]]/route.js')
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'add'],
    ['yarn.lock', 'yarn', 'add'],
    ['bun.lock', 'bun', 'add'],
    ['package-lock.json', 'npm', 'install'],
  ])('installs with the app’s package manager: %s', (lock, command, add) => {
    const dir = app({ [lock]: '' })
    if (lock !== 'package-lock.json') rmSync(join(dir, 'package-lock.json'))
    expect(plan(detect(dir)).install).toEqual({ command, args: [add, '@otwdesign/db-next'] })
  })

  it('finds the lockfile at a monorepo’s root, and installs in the app', () => {
    const root = app({
      'pnpm-lock.yaml': '',
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '16' } }),
      'apps/web/app/page.tsx': '',
    })
    rmSync(join(root, 'package-lock.json'))
    const detected = detect(join(root, 'apps/web'))
    expect(detected.manager).toBe('pnpm')
    const run = vi.fn()
    apply(detected, plan(detected), run)
    expect(run).toHaveBeenCalledWith('pnpm', ['add', '@otwdesign/db-next'], join(root, 'apps/web'))
  })

  it('goes where --path says, under next.config’s basePath as the browser has it', () => {
    const dir = app({
      'next.config.ts': `export default { basePath: '/docs', reactStrictMode: true }`,
    })
    const planned = plan(detect(dir), { path: '/admin/db/' })
    expect(planned.files[0]).toEqual({
      path: 'app/admin/db/[[...path]]/route.ts',
      content: routeFile('/docs/admin/db'),
    })
    expect(planned.url).toBe('/docs/admin/db')
    expect(plan(detect(dir), { path: 'db' }).refused).toContain('--path is a path such as /db')
    expect(plan(detect(dir), { path: '/d b' }).refused).toContain('not "/d b"')
  })

  it('refuses a directory that isn’t a Next.js app', () => {
    const dir = app({ 'package.json': JSON.stringify({ dependencies: { express: '5' } }) })
    expect(plan(detect(dir)).refused).toBe(
      'This isn’t a Next.js app: package.json has no "next" among its dependencies. Run it in the app’s own directory.',
    )
    expect(() => apply(detect(dir), plan(detect(dir)))).toThrow('This isn’t a Next.js app')
  })

  it.each(['app/db/page.tsx', 'pages/db.tsx', 'pages/db/index.tsx'])(
    'writes over nothing: refuses where the app has %s',
    (existing) => {
      const dir = app({ [existing]: 'theirs' })
      const planned = plan(detect(dir))
      expect(planned.refused).toMatch(/is there already: the app has something at \/db\./)
      expect(planned.files).toEqual([])
      expect(readIn(dir, existing)).toBe('theirs')
    },
  )

  it('adds to .env.local what isn’t there, after what is', () => {
    const dir = app({
      '.env.local': 'DATABASE_URL=postgres://u:p@h/app\nDB_ADMIN_USERS=me@example.com',
    })
    const detected = detect(dir)
    apply(detected, plan(detected, { password: PASSWORD, install: false }), vi.fn())
    expect(readIn(dir, '.env.local')).toBe(
      [
        'DATABASE_URL=postgres://u:p@h/app',
        'DB_ADMIN_USERS=me@example.com',
        '',
        '# OTW DB (/db). Whoever has this password can open the database.',
        `DB_ADMIN_PASSWORD=${PASSWORD}`,
        '# The database it opens: the app’s own (DATABASE_URL), read-only. To choose another, or more:',
        '# DB_ADMIN_MAIN_URL=postgres://user:password@host:5432/database',
        '# DB_ADMIN_MAIN_ACCESS=write   # read, unless you say so',
        '',
      ].join('\n'),
    )
    // Run again, there's nothing left to add, and the password stays the one it made.
    const again = plan(detect(dir), { path: '/other' })
    expect(again.env).toBeNull()
  })

  it('writes no password where git would pick it up, and gives it to the person instead', () => {
    const dir = app({ '.gitignore': 'node_modules\n' })
    const detected = detect(dir)
    const planned = plan(detected, { password: PASSWORD })
    expect(planned.env).toBeNull()
    expect(planned.notes[0]).toContain('.gitignore doesn’t keep .env.local out of git')
    expect(planned.notes[0]).toContain(`DB_ADMIN_PASSWORD=${PASSWORD}`)
    apply(detected, planned, vi.fn())
    expect(() => readIn(dir, '.env.local')).toThrow()
  })

  it('says what to do about middleware that guards every route', () => {
    const notes = plan(detect(app({ 'src/app/page.tsx': '', 'src/proxy.ts': '' }))).notes.join('\n')
    expect(notes).toContain('This app has src/proxy.ts.')
    expect(notes).toContain("matcher: ['/((?!db|_next/static|_next/image|favicon.ico).*)']")
    expect(plan(detect(app())).notes.join('\n')).not.toContain('matcher')
  })

  it('tells an app on Supabase’s API alone where its database’s address is', () => {
    const supabaseOnly = app({
      'package.json': JSON.stringify({ dependencies: { next: '16', '@supabase/ssr': '0.12' } }),
      '.env.local':
        'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=k\n',
    })
    const notes = plan(detect(supabaseOnly)).notes.join('\n')
    expect(notes).toContain(
      'copy the “Session pooler” connection string, and set it as DB_ADMIN_MAIN_URL',
    )
    expect(notes).toContain(
      'the users you list in DB_ADMIN_USERS are recognised by their session, with no code',
    )
    expect(notes).toContain('keep “Confirm email” on')
    // Linked through Vercel's integration, the address is there already.
    const linked = app({
      '.env.local':
        'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nPOSTGRES_URL=postgres://a\nPOSTGRES_URL_NON_POOLING=postgres://b\n',
    })
    const planned = plan(detect(linked), { password: PASSWORD })
    expect(planned.notes.join('\n')).not.toContain('Session pooler')
    expect(planned.env!.lines.join('\n')).toContain(
      'the app’s own (POSTGRES_URL_NON_POOLING), read-only',
    )
    // Another sign-in: the one line that says who is signed in.
    expect(plan(detect(app())).notes.join('\n')).toContain(
      'createDbRoute({ user: async () => (await auth())?.user?.email })',
    )
  })

  it.each([
    ['20.x', true],
    ['^18.17.0', true],
    ['20', true],
    ['>=18', false],
    ['>=22.18', false],
    ['24.x', false],
  ])('warns of a Node the tool can’t run on: engines.node %s', (range, warns) => {
    const dir = app({
      'package.json': JSON.stringify({ dependencies: { next: '16' }, engines: { node: range } }),
    })
    expect(plan(detect(dir)).notes.join('\n').includes('OTW DB needs 22.18 or newer')).toBe(warns)
  })

  it('installs nothing with --no-install, or where the package is there', () => {
    expect(plan(detect(app()), { install: false }).install).toBeNull()
    const has = app({
      'package.json': JSON.stringify({ dependencies: { next: '16', '@otwdesign/db-next': '1' } }),
    })
    expect(plan(detect(has)).install).toBeNull()
  })

  it('reports what it did without printing the password', () => {
    const detected = detect(app())
    const planned = plan(detected, { password: PASSWORD })
    const said = report(detected, planned, false)
    expect(said).toContain('Did write app/db/[[...path]]/route.ts')
    expect(said).toContain('DB_ADMIN_PASSWORD=(a new password, 32 characters)')
    expect(said).not.toContain(PASSWORD)
    expect(said).toContain('Did run npm install @otwdesign/db-next')
    expect(said).toContain('vercel env add DB_ADMIN_PASSWORD')
    expect(said.trimEnd().endsWith('Start the app and open /db.')).toBe(true)
    expect(report(detected, planned, true)).toContain('Would write app/db/[[...path]]/route.ts')
  })
})

describe('the otw-db-next command', () => {
  function captured() {
    const out: string[] = []
    const write = (chunk: string | Uint8Array) => (out.push(String(chunk)), true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write)
    return {
      text: () => out.join(''),
      restore() {
        stdout.mockRestore()
        stderr.mockRestore()
        process.exitCode = undefined
      },
    }
  }

  it('changes nothing with --dry-run, and says what it would do', async () => {
    const dir = app()
    const said = captured()
    try {
      await main(['init', '--dry-run'], dir)
      expect(said.text()).toContain('Would write app/db/[[...path]]/route.ts')
      expect(said.text()).toContain('Nothing was changed: run it again without --dry-run.')
    } finally {
      said.restore()
    }
    expect(() => readIn(dir, 'app/db/[[...path]]/route.ts')).toThrow()
    expect(() => readIn(dir, '.env.local')).toThrow()
  })

  it('writes the files with --no-install, at the path given', async () => {
    const dir = app()
    const said = captured()
    try {
      await main(['init', '--no-install', '--path', '/admin/db'], dir)
      expect(said.text()).toContain('Start the app and open /admin/db.')
      expect(said.text()).not.toContain('npm install')
    } finally {
      said.restore()
    }
    expect(readIn(dir, 'app/admin/db/[[...path]]/route.ts')).toBe(routeFile('/admin/db'))
    expect(readIn(dir, '.env.local')).toMatch(/^DB_ADMIN_PASSWORD=[\w-]{32}$/m)
  })

  it('says how it’s used when asked, or when it isn’t told to init; and why it won’t run', async () => {
    const said = captured()
    try {
      await main(['--help'], app())
      expect(said.text()).toContain('Usage: npx @otwdesign/db-next init')
      expect(process.exitCode).toBeUndefined()
      await main([], app())
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined
      await main(['init'], app({ 'package.json': '{}' }))
      expect(said.text()).toContain('This isn’t a Next.js app')
      expect(process.exitCode).toBe(1)
    } finally {
      said.restore()
    }
  })
})
