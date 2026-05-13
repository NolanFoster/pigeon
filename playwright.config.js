import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PIGEON_URL || 'http://localhost:8787',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Apply D1 migrations into the local SQLite before serving — wrangler dev
    // does not auto-migrate, so without this the `messages` table is missing
    // and every request that hits D1 fails with SQLITE_ERROR.
    command: 'npx wrangler d1 migrations apply DB --local && npx wrangler dev',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
