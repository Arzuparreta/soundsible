import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  timeout: 30_000,
  // Two WebKit projects and two Chromium ones, four browsers deep on a shared
  // four-core runner, is enough memory pressure to have the browser killed
  // mid-`page.evaluate`. That surfaces as "Target page, context or browser has
  // been closed" — an infrastructure death, not a failed assertion, and it took
  // `main` red twice. One worker on CI trades wall time for a run whose red
  // means something. Locally the default stays.
  workers: process.env.CI ? 1 : undefined,
  // A crash that survives being the only thing running is worth reporting.
  // Anything that passes on the retry is still called out as flaky.
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 7_500, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.015 } },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'es-ES',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/player/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'], browserName: 'chromium', viewport: { width: 390, height: 844 } },
    },
    {
      name: 'webkit-mobile',
      use: { ...devices['iPhone 13'], browserName: 'webkit', viewport: { width: 390, height: 844 } },
    },
    {
      name: 'chromium-desktop',
      use: { browserName: 'chromium', viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'webkit-desktop',
      use: { browserName: 'webkit', viewport: { width: 1366, height: 768 } },
    },
  ],
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
});
