import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  // The workspace, so Turbopack follows the linked packages there.
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
}

export default config
