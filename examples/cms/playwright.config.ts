import { defineConfig, devices } from '@playwright/test'

const PORT = 3471

export default defineConfig({
  testDir: './e2e',
  // One site on one embedded database, set up by the first test.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // A fresh embedded database each run, so the first visit sets the site up.
    // Built first (the repo's test:e2e does); a fresh database each run.
    command: `node -e "fs.rmSync('.data/e2e', { recursive: true, force: true })" && pnpm start`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: { CMS_DATA_DIR: '.data/e2e', DATABASE_URL: '' },
  },
})
