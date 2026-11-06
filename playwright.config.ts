import { defineConfig, devices } from '@playwright/test'

const PORT = 3472

export default defineConfig({
  testDir: './e2e',
  // One database for the whole run.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 760 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 760 } },
    },
  ],
  webServer: {
    // Built packages, as a site runs them: `pnpm build` first.
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_PORT: String(PORT) },
  },
})
