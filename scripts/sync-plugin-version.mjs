// Runs after `changeset version`: the CMS plugin's `version` in its definition, which the CMS's
// Plugins screen shows, follows its package.json. packages/plugin/test/version.test.ts fails if the
// two ever differ.
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(
  readFileSync(new URL('../packages/plugin/package.json', import.meta.url), 'utf8'),
)
const file = new URL('../packages/plugin/src/index.ts', import.meta.url)
const source = readFileSync(file, 'utf8')
// The definition's own `version:`, indented one level inside definePlugin({ … }).
const line = /^ {2}version: '[^']*',$/m
if (!line.test(source)) throw new Error(`${file.pathname} has no plugin version line to update`)
writeFileSync(file, source.replace(line, `  version: '${version}',`))
console.log(`The plugin's version is ${version}`)
