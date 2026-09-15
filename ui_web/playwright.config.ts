import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SOUNDSIBLE_UI_TEST_PORT || 4173);

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
  //
  // It thinned them out; it did not end them. What is left is WebKit's alone,
  // only in the specs that start the audio graph, and at any point in the run —
  // one landed on the second test of the WebKit block, which no amount of
  // accumulated memory explains. `ci.yml` carries the current suspect and the
  // logging that will confirm or kill it.
  workers: process.env.CI ? 1 : undefined,
  // A crash that survives being the only thing running is worth reporting.
  // Anything that passes on the retry is still called out as flaky.
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 7_500, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.015 } },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'es-ES',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/player/`,
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
