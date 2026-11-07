// OTW DB as people install it: the five packages packed as npm would publish them, installed with
// npm from those tarballs (everything else from the registry) into apps that aren't part of this
// repo, then type-checked, built and run against PostgreSQL:
//
//   1. a TypeScript Express app (type-checked without skipLibCheck, so our .d.ts files are too);
//   2. the otw-db command, from @otwdesign/db alone;
//   3. an OTW CMS site made by create-otw-cms from npm, with the Database plugin;
//   4. the same site installed with pnpm, querying PostgreSQL through the plugin.
//
// It catches what the workspace hides, where every package's devDependencies are installed: a
// file, a type or a dependency the published packages forgot.
//
//   node scripts/packed-check.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { startPostgres } from '../e2e/postgres.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGES = ['core', 'ui', 'node', 'db', 'plugin']
const CMS = '1.1.0'
const keep = process.argv.includes('--keep')
const work = mkdtempSync(join(tmpdir(), 'otw-db-packed-'))
const servers = []

const run = (command, args, cwd, env = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const write = (file, content) =>
  writeFileSync(
    file,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  )

/** A port nothing listens on. */
function freePort() {
  return new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
}

/** Starts a server in its own process group, so stopping it stops what it started (next start). */
function serve(command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  servers.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    process.stdout.write(chunk)
  })
  return { child, output: () => output }
}

async function until(what, check, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    const value = await check().catch(() => undefined)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function expect(what, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  if (!ok) throw new Error(`${what}: got ${JSON.stringify(actual)}`)
  console.log(`  ✓ ${what}`)
}

const api = (base, path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'x-db-admin': '1', 'content-type': 'application/json', ...init.headers },
  })

try {
  // Each package as npm would publish it, built first: these ship compiled code.
  run('pnpm', ['build'], ROOT)
  const tarballs = join(work, 'tarballs')
  const byName = new Map()
  for (const folder of PACKAGES) {
    const dir = join(ROOT, 'packages', folder)
    const { name, version } = manifestOf(dir)
    run('pnpm', ['pack', '--pack-destination', tarballs], dir)
    byName.set(name, join(tarballs, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`))
  }
  const local = (name) => `file:${byName.get(name)}`
  // The packages' own dependencies on each other come from the tarballs too, not the registry.
  const overrides = Object.fromEntries([...byName.keys()].map((name) => [name, local(name)]))

  const url = await startPostgres(`
    DROP TABLE IF EXISTS packed_items;
    CREATE TABLE packed_items (id integer PRIMARY KEY, name text NOT NULL);
    INSERT INTO packed_items VALUES (1, 'from the packed packages');
  `)
  const connection = { DB_ADMIN_MAIN_URL: url, DB_ADMIN_MAIN_ACCESS: 'read' }

  // 1. A TypeScript Express app.
  console.log('\n— An Express app')
  const express = join(work, 'express')
  mkdirSync(express)
  write(join(express, 'package.json'), {
    name: 'packed-express',
    private: true,
    type: 'module',
    dependencies: {
      '@otwdesign/db-core': local('@otwdesign/db-core'),
      '@otwdesign/db-node': local('@otwdesign/db-node'),
      express: '^5.3.0',
      pg: '^8.23.1',
      'pg-cursor': '^2.22.1',
    },
    devDependencies: { '@types/express': '^5.0.6', '@types/node': '^24.0.0', typescript: '~6.0.3' },
    overrides,
  })
  write(join(express, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      // Every declaration file checked, ours included.
      skipLibCheck: false,
      types: ['node'],
    },
    include: ['app.ts'],
  })
  write(
    join(express, 'app.ts'),
    `import express from 'express'
import type { AddressInfo } from 'node:net'
import { connectionsFromEnv, createDbAdmin, type Viewer } from '@otwdesign/db-core'
import { toNodeHandler } from '@otwdesign/db-node'

const admin = createDbAdmin({
  basePath: '/db',
  connections: connectionsFromEnv(),
  authorize: (request): Viewer | null =>
    request.headers.get('authorization') === 'Bearer packed' ? { id: 'packed' } : null,
})
const app = express()
app.use(express.json())
app.use('/db', toNodeHandler(admin))
const server = app.listen(0, '127.0.0.1', () => {
  console.log(\`listening on \${(server.address() as AddressInfo).port}\`)
})
`,
  )
  run('npm', ['install', '--no-audit', '--no-fund'], express)
  run('npx', ['tsc', '-p', '.'], express)
  console.log('  ✓ type-checks, every declaration file included')
  const expressApp = serve('node', ['app.ts'], express, connection)
  const port = await until(
    'the Express app',
    async () => /listening on (\d+)/.exec(expressApp.output())?.[1],
  )
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: 'Bearer packed' }
  const listed = await (await api(base, '/db/api/connections', { headers: auth })).json()
  expect('lists the connection', listed.connections?.[0]?.name, 'main')
  const queried = await (
    await api(base, '/db/api/query', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ connection: 'main', sql: 'SELECT name FROM packed_items' }),
    })
  ).json()
  expect('runs a query', queried.rows?.[0]?.[0], 'from the packed packages')
  const page = await (await fetch(`${base}/db/`)).text()
  const script = /src="(\/db\/assets\/[^"]+\.js)"/.exec(page)?.[1]
  expect('serves the page', script, (s) => typeof s === 'string')
  expect('serves its script', (await fetch(`${base}${script}`)).status, 200)
  run(
    'node',
    [
      '-e',
      "const core = require('@otwdesign/db-core'); if (typeof core.createDbAdmin !== 'function') process.exit(1)",
    ],
    express,
  )
  console.log('  ✓ CommonJS require()s it')

  // 2. The otw-db command, from @otwdesign/db alone.
  console.log('\n— npx @otwdesign/db')
  const standalone = join(work, 'standalone')
  mkdirSync(standalone)
  write(join(standalone, 'package.json'), {
    name: 'packed-standalone',
    private: true,
    dependencies: { '@otwdesign/db': local('@otwdesign/db') },
    overrides,
  })
  run('npm', ['install', '--no-audit', '--no-fund'], standalone)
  const command = serve(
    join(standalone, 'node_modules/.bin/otw-db'),
    ['--port', '0'],
    standalone,
    connection,
  )
  const link = await until('otw-db', async () => /Open (http\S+)/.exec(command.output())?.[1])
  const opened = new URL(link)
  const token = { authorization: `Bearer ${opened.searchParams.get('token')}` }
  const standaloneQuery = await (
    await api(opened.origin, '/api/query', {
      method: 'POST',
      headers: token,
      body: JSON.stringify({ connection: 'main', sql: 'SELECT count(*) FROM packed_items' }),
    })
  ).json()
  expect('runs a query with every driver it brings', standaloneQuery.rows?.[0]?.[0], '1')

  // 3. A CMS site from npm, with the plugin.
  console.log(`\n— An OTW CMS site (create-otw-cms@${CMS}) with the Database plugin`)
  const site = join(work, 'site')
  run('npx', ['-y', `create-otw-cms@${CMS}`, site, '--no-install'], work, {
    npm_config_user_agent: 'npm/11',
  })
  const manifest = manifestOf(site)
  manifest.dependencies['@otwdesign/plugin-db'] = local('@otwdesign/plugin-db')
  manifest.overrides = { ...manifest.overrides, ...overrides }
  write(join(site, 'package.json'), manifest)
  const config = JSON.parse(readFileSync(join(site, 'cms.config.json'), 'utf8'))
  config.plugins = [...(config.plugins ?? []), '@otwdesign/plugin-db']
  write(join(site, 'cms.config.json'), config)
  run('npm', ['install', '--no-audit', '--no-fund'], site)
  // A site on PostgreSQL (DATABASE_URL) opens its own database with the pg driver: the plugin
  // brings what that needs, which a CMS site doesn't have of its own (pg-cursor).
  run(
    'node',
    [
      '--input-type=module',
      '-e',
      `const { postgresDriver } = await import('@otwdesign/db-core')
const db = postgresDriver(process.env.DB_ADMIN_MAIN_URL)
const { rows } = await db.query('SELECT name FROM packed_items', { access: 'read', maxRows: 10, timeoutMs: 5000 })
await db.close()
if (rows[0]?.[0] !== 'from the packed packages') throw new Error('The pg driver read ' + JSON.stringify(rows))`,
    ],
    site,
    connection,
  )
  console.log('  ✓ the site’s PostgreSQL driver loads and reads, with what the plugin brings')
  run('npm', ['run', 'typecheck'], site)
  run('npm', ['run', 'build'], site)
  const sitePort = await freePort()
  serve('npx', ['next', 'start', '-p', String(sitePort)], site, {
    CMS_DATA_DIR: join(work, 'site-data'),
    DATABASE_URL: '',
  })
  const siteBase = `http://127.0.0.1:${sitePort}`
  await until('the CMS site', async () => (await fetch(siteBase)).ok, 120)
  // Signed out: the plugin's route answers, through the engine it loads on that first request.
  const refused = await api(siteBase, '/api/p/db/api/connections')
  expect('the plugin answers, and wants a sign-in', refused.status, 401)
  expect('in its own words', (await refused.json()).error?.code, 'unauthorized')
  const { entry } = await import(
    pathToFileURL(join(site, 'node_modules/@otwdesign/db-ui/dist/entry.js')).href
  )
  expect(
    'serves the app’s script',
    (await fetch(`${siteBase}/api/p/db/assets/${entry.script}`)).status,
    200,
  )

  // 4. The same site installed with pnpm, which keeps a package's dependencies beside it rather
  // than in the site's root: the plugin's pg and pg-cursor can't be imported from where the site's
  // bundle runs, only from the plugin.
  console.log(`\n— The CMS site installed with pnpm, querying PostgreSQL through the plugin`)
  const pnpmSite = join(work, 'pnpm-site')
  run('npx', ['-y', `create-otw-cms@${CMS}`, pnpmSite, '--no-install'], work, {
    npm_config_user_agent: 'pnpm/10',
  })
  const pnpmManifest = manifestOf(pnpmSite)
  pnpmManifest.dependencies['@otwdesign/plugin-db'] = local('@otwdesign/plugin-db')
  pnpmManifest.pnpm = { overrides }
  write(join(pnpmSite, 'package.json'), pnpmManifest)
  write(join(pnpmSite, 'cms.config.json'), config)
  // A new site has no lockfile, and pnpm wants a frozen one on CI.
  run('pnpm', ['install', '--no-frozen-lockfile', '--config.confirmModulesPurge=false'], pnpmSite)
  run('pnpm', ['run', 'build'], pnpmSite)
  const pnpmPort = await freePort()
  serve('pnpm', ['exec', 'next', 'start', '-p', String(pnpmPort)], pnpmSite, {
    ...connection,
    CMS_DATA_DIR: join(work, 'pnpm-site-data'),
    DATABASE_URL: '',
  })
  // localhost, not 127.0.0.1: the admin's forms check the origin they're posted from.
  const pnpmBase = `http://localhost:${pnpmPort}`
  await until('the pnpm site', async () => (await fetch(pnpmBase)).ok, 120)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`${pnpmBase}/admin`)
    await page.waitForURL(/\/admin\/setup/)
    await page.getByLabel('Name').fill('Packed Admin')
    await page.getByLabel('Email').fill('packed@example.com')
    await page.getByLabel('Password').fill('a strong packed password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.getByRole('status').filter({ hasText: 'Your site is ready.' }).waitFor()
    // The administrator's own session, as the Database screen sends it.
    const answer = await page.evaluate(async () => {
      const response = await fetch('/api/p/db/api/query', {
        method: 'POST',
        headers: { 'x-db-admin': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ connection: 'main', sql: 'SELECT name FROM packed_items' }),
      })
      return response.json()
    })
    expect(
      'opens a PostgreSQL connection with the pg the plugin brings',
      answer.rows?.[0]?.[0] ?? answer.error?.message,
      'from the packed packages',
    )
  } finally {
    await browser.close()
  }

  console.log(`\nThe packed packages install, type-check, build and run${keep ? `: ${work}` : '.'}`)
} finally {
  for (const server of servers) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  if (!keep) rmSync(work, { recursive: true, force: true })
}
