import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SOUNDSIBLE_UI_TEST_PORT || 4173);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  timeout: 30_000,
  // One worker on CI trades wall time for a run whose red means something.
  // Locally the default stays.
  workers: process.env.CI ? 1 : undefined,
  // A crash that survives being the only thing running is worth reporting.
  // Anything that passes on the retry is still called out as flaky.
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 7_500, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.015 } },
  use: {
    // "Target page, context or browser has been closed" is what a pending
    // action reports after the harness tears its context down, so it is the
    // message for a browser that died *and* for a test that spent its whole
    // budget waiting — two very different bugs behind one string. The `Test
    // timeout` line above it tells them apart, and the trace says which element
    // never became actionable, which is the part no log line carries. Traces
    // ride in the HTML report the job already uploads.
    // Not `on-first-retry`: these fail on the first attempt in a cold context
    // and pass on the retry, so tracing the retry records the run that worked.
    trace: 'retain-on-failure',
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
