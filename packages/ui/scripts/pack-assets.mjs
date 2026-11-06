// Turns vite's build into one module of strings, which db-core imports and serves, so it works
// wherever the host runs: no file paths to find, nothing for a bundler to miss.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}
// fileURLToPath, not .pathname, which keeps a space in the path as %20.
const app = fileURLToPath(new URL('../dist/app/', import.meta.url))
const placeholder = /\/__OTW_DB_BASE__/g
const files = {}
for (const name of readdirSync(join(app, 'assets'))) {
  const type = TYPES[extname(name)]
  if (!type) throw new Error(`pack-assets: no type for ${name}; add it, or keep binary files out.`)
  files[name] = {
    type,
    body: readFileSync(join(app, 'assets', name), 'utf8').replace(placeholder, '%OTW_DB_BASE%'),
  }
}
const index = readFileSync(join(app, 'index.html'), 'utf8').replace(placeholder, '%OTW_DB_BASE%')
// The script and stylesheet the page loads, for hosts that embed the app in their own pages.
const entry = {
  script: /src="%OTW_DB_BASE%\/assets\/([^"]+\.js)"/.exec(index)?.[1],
  style: /href="%OTW_DB_BASE%\/assets\/([^"]+\.css)"/.exec(index)?.[1],
}
if (!entry.script || !entry.style)
  throw new Error('pack-assets: the page has no script or stylesheet.')
writeFileSync(
  new URL('../dist/assets.js', import.meta.url),
  `export const assets = ${JSON.stringify({ index, files, entry })}\n`,
)
const size = Object.values(files).reduce((sum, f) => sum + f.body.length, 0)
console.log(`pack-assets: ${Object.keys(files).length} files, ${Math.round(size / 1024)} KB`)
