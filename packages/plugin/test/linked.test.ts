import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

// A site that links the plugin from a checkout (pnpm's link:, as the CMS's docs site does) has its
// own copy of @types/react, and the plugin's source resolves the checkout's. TypeScript keeps one
// file per package version and redirects the other to it, and a `declare module 'react'` can't
// augment a redirected file. So the plugin's sources must type-check with React's types coming
// from the site.
const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const resolveFrom = createRequire(join(PLUGIN, 'package.json'))
const packageDir = (from: NodeJS.Require, name: string) =>
  dirname(from.resolve(`${name}/package.json`))
const site = mkdtempSync(join(tmpdir(), 'otw-db-linked-'))

afterAll(() => rmSync(site, { recursive: true, force: true }))

/** The site: React's types copied in (a second copy, the same version), the plugin linked. */
function linkedSite() {
  const modules = join(site, 'node_modules')
  const reactTypes = packageDir(resolveFrom, '@types/react')
  mkdirSync(join(modules, '@types'), { recursive: true })
  mkdirSync(join(modules, '@otwdesign'))
  cpSync(realpathSync(reactTypes), join(modules, '@types/react'), { recursive: true })
  const csstype = packageDir(
    createRequire(join(realpathSync(reactTypes), 'package.json')),
    'csstype',
  )
  symlinkSync(realpathSync(csstype), join(modules, 'csstype'))
  symlinkSync(realpathSync(packageDir(resolveFrom, '@types/node')), join(modules, '@types/node'))
  symlinkSync(PLUGIN, join(modules, '@otwdesign/plugin-db'))
  // The site's own React comes first, as in a site's generated module.
  writeFileSync(
    join(site, 'site.tsx'),
    `import type { ReactNode } from 'react'
import plugin from '@otwdesign/plugin-db'
import admin from '@otwdesign/plugin-db/admin'

export const node: ReactNode = null
export const site = { plugins: [plugin], admin: [admin] }
`,
  )
  return join(site, 'site.tsx')
}

describe('a site that links the plugin from a checkout', () => {
  it('type-checks the plugin with its own copy of React’s types', () => {
    const program = ts.createProgram([linkedSite()], {
      // A create-otw-cms site's options, and the workspace's source in place of its build.
      target: ts.ScriptTarget.ES2023,
      lib: ['lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.es2023.d.ts'],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      customConditions: ['@otwdesign/source'],
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      isolatedModules: true,
      allowImportingTsExtensions: true,
      types: ['node'],
    })
    const host = {
      getCanonicalFileName: (name: string) => name,
      getCurrentDirectory: () => PLUGIN,
      getNewLine: () => '\n',
    }
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.formatDiagnostic(d, host))
    expect(errors).toEqual([])
  }, 60_000)
})
