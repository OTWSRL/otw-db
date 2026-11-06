import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import db from '../src/index.ts'

// A release bumps package.json (changeset version), and scripts/sync-plugin-version.mjs carries
// the version into the plugin's definition, which the CMS's Plugins screen shows. This keeps them one.
describe('the plugin’s version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(db.version).toBe(pkg.version)
  })
})
