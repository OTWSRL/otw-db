import { resolve } from 'node:path'
import { withCms } from '@otwdesign/next/config'

// The CMS comes from a checkout beside this repo (../nextjs-cms), so Turbopack's root must hold
// both. Next runs from this directory.
const root = resolve(process.cwd(), '..', '..', '..')

export default withCms({ turbopack: { root }, outputFileTracingRoot: root })
