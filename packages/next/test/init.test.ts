import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
/** The variables a new app is left to set, as `init` lists them. */
const TO_SET = [
  '# OTW DB (/db). A password of your own, 16 characters at least: whoever has it can open the database.',
  'DB_ADMIN_PASSWORD=',
  '# The app’s signed-in users who get in without it: their emails, comma-separated.',
  '# DB_ADMIN_USERS=you@example.com,colleague@example.com',
  '# The database it opens, such as postgres://user:password@host:5432/database:',
  'DB_ADMIN_MAIN_URL=',
  '# DB_ADMIN_MAIN_ACCESS=write   # read, unless you say so',
]

describe('otw-db-next init', () => {
  it('writes one route file and installs the package; the variables are the person’s to set', () => {
    const dir = app()
    const detected = detect(dir)
    const planned = plan(detected)
    expect(planned.refused).toBeNull()
    expect(planned.files.map((f) => f.path)).toEqual(['app/db/[[...path]]/route.ts'])
    expect(planned.install).toEqual({ command: 'npm', args: ['install', '@otwdesign/db-next'] })
    expect(planned.env).toEqual(TO_SET)
    const run = vi.fn()
    apply(detected, planned, run)
    expect(readIn(dir, 'app/db/[[...path]]/route.ts')).toBe(routeFile('/db'))
    expect(run).toHaveBeenCalledWith('npm', ['install', '@otwdesign/db-next'], detected.dir)
    // One file, and nothing else in the app: no .env.local, no password of anyone's making.
    expect(readdirSync(dir).sort()).toEqual(
      ['.gitignore', 'app', 'package-lock.json', 'package.json', 'tsconfig.json'].sort(),
    )
  })

  it('writes the route the example app has', () => {
    const example = new URL('../../../examples/next/app/db/[[...path]]/route.ts', import.meta.url)
    expect(routeFile('/db')).toBe(readFileSync(example, 'utf8'))
    expect(routeFile('/db')).toContain('export const { GET, POST } = createDbRoute()')
    expect(routeFile('/admin/db')).toContain("createDbRoute({ basePath: '/admin/db' })")
  })

  it('makes no password: the person chooses one, and is told how strong and where to keep it', () => {
    const detected = detect(app())
    const planned = plan(detected)
    // Nothing made at random: asked twice, it says the same.
    expect(plan(detected)).toEqual(planned)
    expect(planned.env).toContain('DB_ADMIN_PASSWORD=')
    expect(planned.env.join('\n')).not.toMatch(/DB_ADMIN_PASSWORD=./)
    expect(planned.notes[0]).toBe(
      'Choose a strong password of your own and set it as DB_ADMIN_PASSWORD: 16 characters at least, from your password manager or a command such as openssl rand -base64 32. It’s set in none of the app’s env files; until it’s set somewhere, nobody signs in with a password. Keep it out of git: in .env.local on your machine (git check-ignore .env.local names the file when git leaves it alone), in your host’s settings where the app runs.',
    )
    const said = report(detected, planned, false)
    expect(said).toContain('Yours to add to the app’s environment')
    expect(said).toContain('      DB_ADMIN_PASSWORD=\n')
    expect(said.trimEnd().endsWith('Set DB_ADMIN_PASSWORD, start the app and open /db.')).toBe(true)
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

  it('lists only what isn’t set, and leaves .env.local as it is', () => {
    const mine = 'DATABASE_URL=postgres://u:p@h/app\nDB_ADMIN_USERS=me@example.com'
    const dir = app({ '.env.local': mine })
    const detected = detect(dir)
    const planned = plan(detected, { install: false })
    expect(planned.env).toEqual([
      '# OTW DB (/db). A password of your own, 16 characters at least: whoever has it can open the database.',
      'DB_ADMIN_PASSWORD=',
      '# The database it opens: the app’s own (DATABASE_URL), read-only. To choose another, or more:',
      '# DB_ADMIN_MAIN_URL=postgres://user:password@host:5432/database',
      '# DB_ADMIN_MAIN_ACCESS=write   # read, unless you say so',
    ])
    apply(detected, planned, vi.fn())
    expect(readIn(dir, '.env.local')).toBe(mine)

    // With the password and an address set, there's nothing left to list, or to say of it.
    const set = app({
      '.env.local': `${mine}\nDB_ADMIN_PASSWORD=one-of-my-own-choosing-1\nDB_ADMIN_MAIN_URL=postgres://h/db\n`,
    })
    const done = plan(detect(set))
    expect(done.env).toEqual([])
    expect(done.notes.join('\n')).not.toContain('Choose a strong password')
    expect(report(detect(set), done, false).trimEnd().endsWith('Start the app and open /db.')).toBe(
      true,
    )
  })

  it.skipIf(process.platform === 'win32')('waits on no .env.local that isn’t a file', () => {
    const dir = app()
    // A pipe of that name: opened to be read, it would hold the command for ever.
    execFileSync('mkfifo', [join(dir, '.env.local')])
    expect(plan(detect(dir)).env).toEqual(TO_SET)
  })

  it('takes a package.json that holds no object for no app, not for a crash', () => {
    for (const text of ['null', '[]', '7', '{']) {
      const planned = plan(detect(app({ 'package.json': text })), { install: false })
      expect(planned.refused).toContain('Next.js')
    }
  })

  it('writes no route through a link that leads out of the app', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'otw-db-elsewhere-'))
    made.push(elsewhere)
    const dir = app()
    rmSync(join(dir, 'app'), { recursive: true })
    symlinkSync(elsewhere, join(dir, 'app'))
    const planned = plan(detect(dir), { install: false })
    expect(planned.refused).toContain('is a link to somewhere outside this app')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('takes a Node range that isn’t text for what it is: nothing to read', () => {
    const dir = app({
      'package.json': JSON.stringify({ dependencies: { next: '^16.0.0' }, engines: { node: 20 } }),
    })
    expect(plan(detect(dir), { install: false }).refused).toBeNull()
  })

  it('reads package.json’s Node range in no time, whatever is written there', () => {
    const dir = app({
      'package.json': JSON.stringify({
        dependencies: { next: '^16.0.0' },
        engines: { node: `${' '.repeat(200_000)}x` },
      }),
    })
    const started = performance.now()
    plan(detect(dir), { install: false })
    expect(performance.now() - started).toBeLessThan(500)
    const old = detect(
      app({
        'package.json': JSON.stringify({
          dependencies: { next: '^16.0.0' },
          engines: { node: ' ^18.17 ' },
        }),
      }),
    )
    expect(plan(old, { install: false }).notes.join('\n')).toContain('OTW DB needs 22.18 or newer')
  })

  it('says so when the password in use is in .env, the file apps keep in git', () => {
    const inDotEnv = detect(app({ '.env': 'DB_ADMIN_PASSWORD=a-password-from-a-template\n' }))
    expect(inDotEnv.passwordInDotEnv).toBe(true)
    const planned = plan(inDotEnv)
    expect(planned.notes.join('\n')).toContain(
      'DB_ADMIN_PASSWORD is set in .env, a file apps usually keep in git.',
    )
    // It's set, so it isn't asked for again.
    expect(planned.env).not.toContain('DB_ADMIN_PASSWORD=')
    const inLocal = detect(app({ '.env.local': 'DB_ADMIN_PASSWORD=a-password-kept-out-of-git\n' }))
    expect(inLocal.passwordInDotEnv).toBe(false)
  })

  it('prints nothing of the app’s own files but names and numbers it has checked', () => {
    const escape = String.fromCharCode(27)
    const forged = `${escape}[2J${escape}[H${escape}]52;c;eA==${String.fromCharCode(7)}\n      DB_ADMIN_PASSWORD=chosen-by-the-folder-0001`
    const dir = app({
      'package.json': JSON.stringify({
        dependencies: { next: '^16.0.0' },
        engines: { node: `20${'.0'.repeat(15)}${forged}` },
        packageManager: `pnpm@9${forged}`,
      }),
      'next.config.mjs': `export default { basePath: '/docs${forged}' }\n`,
      '.env': `DB_ADMIN_PASSWORD=from-the-folder-0002${forged}\n`,
      'middleware.ts': forged,
    })
    for (const dryRun of [true, false]) {
      const detected = detect(dir)
      const said = report(detected, plan(detected, { install: false }), dryRun)
      // Text and line ends, and nothing a terminal acts on.
      expect(said).not.toMatch(/[^\n\P{Cc}]/u)
      expect(said).not.toContain('chosen-by-the-folder')
      expect(said).not.toContain('from-the-folder')
    }
    // And whatever a later change quotes: escapes, DEL and the second set of control codes go.
    const detected = detect(dir)
    const planned = plan(detected, { install: false })
    const noisy = `a${escape}[2Jb${String.fromCharCode(0x7f, 0x9b, 0x9d)}c\rd`
    const said = report(detected, { ...planned, notes: [noisy] }, false)
    expect(said).toContain('- a[2Jbcd\n')
    expect(said).not.toMatch(/[^\n\P{Cc}]/u)
    // A Node the tool can't run on is still said, by its number.
    const old = app({
      'package.json': JSON.stringify({ dependencies: { next: '16' }, engines: { node: '^20.9' } }),
    })
    expect(plan(detect(old)).notes.join('\n')).toContain('package.json asks for Node 20;')
  })

  it('takes next.config’s basePath in one plain shape, and says so of any other', () => {
    const config = (text: string) => detect(app({ 'next.config.mjs': text }))
    const taken = (text: string) => config(text).nextBasePath
    expect(taken("export default { basePath: '/docs' }")).toBe('/docs')
    expect(taken('module.exports = {\n  basePath: "/docs/v2/",\n}\n')).toBe('/docs/v2')
    // None, said or left out: nothing to note.
    for (const none of ['export default {}', "export default { basePath: '' }"]) {
      expect(config(none).basePathUnread, none).toBe(false)
      expect(plan(config(none)).notes.join('\n'), none).not.toContain('basePath')
    }
    // Anything else isn't guessed at: the route would be at the wrong address, in silence.
    const others = [
      "export default { basePath: '/a b' }",
      "export default { basePath: '/caf%C3%A9' }",
      "export default { basePath: '/../up' }",
      "export default { basePath: '/docs//v2' }",
      `export default { basePath: '${'/a'.repeat(150)}' }`,
      // Under the size no file is read past, and long enough to climb if a pattern climbed it.
      `export default { basePath: '${'/a'.repeat(400_000)}' }`,
      'export default { basePath: process.env.BASE }',
      "export default { basePath: process.env.BASE || '/docs' }",
      "export default { basePath: '/docs' + suffix }",
      "export default {\n  // basePath: '/old',\n}",
      "export default {\n  /* basePath: '/old', */\n}",
      "/**\n * basePath: '/old'\n */\nexport default {}",
      "export default { basePath: '/old', ...{ basePath: '/new' } }",
      "const basePath = '/docs'\nexport default { basePath }",
    ]
    for (const text of others) {
      const detected = config(text)
      expect(detected.nextBasePath, text.slice(0, 60)).toBe('')
      expect(plan(detected).notes.join('\n'), text.slice(0, 60)).toContain(
        'next.config mentions basePath in a way this couldn’t read as one plain path',
      )
    }
  })

  it('says of a file it didn’t read that it didn’t, and takes it for nothing else', () => {
    const big = app({
      '.env': `DB_ADMIN_PASSWORD=set-in-a-file-too-large\n#${'x'.repeat(1_100_000)}\n`,
    })
    const detected = detect(big)
    expect(detected.unread).toEqual(['.env'])
    expect(plan(detected).notes.join('\n')).toContain(
      'Not read, so what it sets isn’t counted above: .env (not a file, or larger than such a file is).',
    )
    const manifest = JSON.stringify({ dependencies: { next: '16' }, pad: 'x'.repeat(1_100_000) })
    expect(plan(detect(app({ 'package.json': manifest }))).refused).toBe(
      'package.json couldn’t be read: it isn’t a file, or is larger than such a file is.',
    )
    // Read whichever env file Next reads it from: the password isn't asked for twice.
    const production = app({ '.env.production': 'DB_ADMIN_PASSWORD=one-set-for-production\n' })
    expect(plan(detect(production)).env).not.toContain('DB_ADMIN_PASSWORD=')
    const marked = app({
      'package.json': `\uFEFF${JSON.stringify({ dependencies: { next: '16' } })}`,
    })
    expect(detect(marked).next).toBe(true)
  })

  it('writes over nothing that appeared since it looked', () => {
    const dir = app()
    const detected = detect(dir)
    const planned = plan(detected, { install: false })
    mkdirSync(join(dir, 'app/db/[[...path]]'), { recursive: true })
    writeFileSync(join(dir, 'app/db/[[...path]]/route.ts'), 'mine\n')
    expect(() => apply(detected, planned, vi.fn())).toThrow(/EEXIST/)
    expect(readIn(dir, 'app/db/[[...path]]/route.ts')).toBe('mine\n')
  })

  it('takes next.config’s basePath only when it’s a path, and writes nothing else of it', () => {
    const odd = detect(
      app({
        'next.config.mjs': 'export default { basePath: `/docs\\\n;globalThis.INJECTED=1;//x` }\n',
      }),
    )
    expect(odd.nextBasePath).toBe('')
    expect(plan(odd).files[0]!.content).not.toContain('INJECTED')
    expect(
      detect(app({ 'next.config.mjs': "export default { basePath: '/docs/v2' }\n" })).nextBasePath,
    ).toBe('/docs/v2')
  })

  it('takes no --path that climbs out of the app, or names the folder it’s in', () => {
    const detected = detect(app())
    for (const path of ['/../outside', '/db/../../outside', '/./db', '/...']) {
      expect(plan(detected, { path }).refused, path).toContain('--path is a path such as /db')
    }
    expect(plan(detected, { path: '/admin/db.v2' }).refused).toBeNull()
    // Nor one longer than a path is: it's written into the route file and printed.
    expect(plan(detected, { path: '/a'.repeat(101) }).refused).toContain('--path is a path such as')
    expect(plan(detected, { path: '/a'.repeat(100) }).refused).toBeNull()
  })

  it('says what it wrote and what’s left to do when the install fails, and can be run again', async () => {
    const dir = app()
    const detected = detect(dir)
    const planned = plan(detected)
    const outcome = apply(detected, planned, () => {
      throw new Error('spawn npm ENOENT')
    })
    expect(outcome.installFailed).toBe('spawn npm ENOENT')
    expect(readIn(dir, 'app/db/[[...path]]/route.ts')).toBe(routeFile('/db'))
    const said = report(detected, planned, false, outcome)
    expect(said).toContain('Did write app/db/[[...path]]/route.ts')
    expect(said).toContain(
      'Couldn’t run npm install @otwdesign/db-next (spawn npm ENOENT). Run it yourself',
    )
    expect(said).toContain('Choose a strong password of your own')

    // Again, with the route there: it goes on from where it stopped, and writes over nothing.
    const again = detect(dir)
    const second = plan(again)
    expect(second.refused).toBeNull()
    expect(second.files).toEqual([])
    const ran = vi.fn()
    apply(again, second, ran)
    expect(ran).toHaveBeenCalledWith('npm', ['install', '@otwdesign/db-next'], dir)
    expect(readIn(dir, 'app/db/[[...path]]/route.ts')).toBe(routeFile('/db'))
  })

  it('still refuses a route of the app’s own at that path', () => {
    const detected = detect(app({ 'app/db/page.tsx': 'export default () => null\n' }))
    expect(plan(detected).refused).toContain('app/db is there already')
    const edited = detect(
      app({ 'app/db/[[...path]]/route.ts': `export const GET = () => new Response('mine')\n` }),
    )
    expect(plan(edited).refused).toContain('app/db is there already')
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
    const planned = plan(detect(linked))
    expect(planned.notes.join('\n')).not.toContain('Session pooler')
    expect(planned.env.join('\n')).toContain('the app’s own (POSTGRES_URL_NON_POOLING), read-only')
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

  it('reports what it did, and what is the person’s to set', () => {
    const detected = detect(app())
    const planned = plan(detected)
    const said = report(detected, planned, false)
    expect(said).toContain('Did write app/db/[[...path]]/route.ts')
    expect(said).toContain('Did run npm install @otwdesign/db-next')
    for (const line of TO_SET) expect(said).toContain(`      ${line}\n`)
    expect(said).toContain('vercel env add DB_ADMIN_PASSWORD')
    expect(report(detected, planned, true)).toContain('Would write app/db/[[...path]]/route.ts')
    expect(report(detected, planned, true)).not.toContain('Did ')
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
      expect(said.text()).toContain('Set DB_ADMIN_PASSWORD, start the app and open /admin/db.')
      expect(said.text()).not.toContain('npm install')
    } finally {
      said.restore()
    }
    expect(readIn(dir, 'app/admin/db/[[...path]]/route.ts')).toBe(routeFile('/admin/db'))
    expect(() => readIn(dir, '.env.local')).toThrow()
  })

  it('says what went wrong in a line, not a stack, for an option it doesn’t have', async () => {
    const said = captured()
    try {
      for (const argv of [
        ['init', '--nope'],
        ['init', '--path'],
      ]) {
        await main(argv, app())
        expect(said.text()).toContain('Usage: npx @otwdesign/db-next init')
        expect(process.exitCode).toBe(1)
        process.exitCode = undefined
      }
      expect(said.text()).not.toContain('    at ')
    } finally {
      said.restore()
    }
  })

  /** What the command says and how it ends, run in `dir`. */
  async function ran(dir: string, ...argv: string[]) {
    const said = captured()
    try {
      await main(argv, dir)
      return { text: said.text(), exitCode: process.exitCode }
    } finally {
      said.restore()
    }
  }

  it.skipIf(process.platform === 'win32')(
    'refuses in a dry run what the run itself couldn’t do, in the same words',
    async () => {
      const inTheWay = app({ 'pages/index.tsx': '' })
      rmSync(join(inTheWay, 'app'), { recursive: true })
      writeFileSync(join(inTheWay, 'app'), 'a file where the folder would be')
      const readOnly = app()
      chmodSync(join(readOnly, 'app'), 0o555)
      const unlistable = app({ 'app/db/[[...path]]/route.ts': routeFile('/db') })
      chmodSync(join(unlistable, 'app/db'), 0o311)
      try {
        const cases = [
          [inTheWay, 'app isn’t a folder: the route can’t be written under it.\n'],
          [
            readOnly,
            'app can’t be written in: the route can’t be made there. Check its permissions.\n',
          ],
          [unlistable, 'app/db is there already: the app has something at /db.'],
        ] as const
        for (const [dir, words] of cases) {
          const dry = await ran(dir, 'init', '--no-install', '--dry-run')
          const real = await ran(dir, 'init', '--no-install')
          expect(dry.text, words).toContain(words)
          expect(real).toEqual(dry)
          expect(dry.exitCode).toBe(1)
          expect(dry.text).not.toContain('    at ')
        }
      } finally {
        chmodSync(join(readOnly, 'app'), 0o755)
        chmodSync(join(unlistable, 'app/db'), 0o755)
      }
    },
  )

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
