import { defineConfig } from 'vitest/config'

// Workspace packages resolve to their TypeScript source, not their build. Tests run on the
// server side, whose conditions Vite takes from `ssr.resolve`; its defaults follow.
const conditions = ['@otwdesign/source', 'module', 'node', 'development|production']

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**'],
    globalSetup: ['./test/postgres.ts'],
    testTimeout: 15_000,
  },
})
