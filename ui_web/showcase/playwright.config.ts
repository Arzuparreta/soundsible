import { defineConfig, devices } from '@playwright/test';
import { closedEngine } from '../playwright.config';

const port = Number(process.env.SOUNDSIBLE_UI_TEST_PORT || 4173);

/**
 * The README and site screenshots, and the social card built from them.
 *
 * Not part of the browser suite: these specs assert nothing about behaviour,
 * they put the app in a known state and write pictures of it. Each viewport
 * and pixel ratio is fixed here, which is what keeps a refresh from changing
 * the zoom of every picture.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  // More than this and the screenshots, each several megapixels rendered
  // without a GPU, starve each other past the timeout in the Playwright image.
  workers: 4,
  // On a cold start Vite finds dependencies as pages ask for them and reloads
  // the page under whatever was running. A failed attempt writes nothing.
  retries: 2,
  timeout: 60_000,
  // A cold dev server compiles the app on its first few page loads, and every
  // worker asks for it at once.
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/player/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { SOUNDSIBLE_DEV_ENGINE: closedEngine },
  },
  projects: [
    {
      // The most common laptop: 1920×1080 at 125% scaling.
      name: 'desktop',
      testMatch: 'screens.spec.ts',
      use: { browserName: 'chromium', viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 },
    },
    {
      // An iPhone 13/14 screen, 1170×2532.
      name: 'mobile',
      testMatch: 'screens.spec.ts',
      use: { ...devices['Pixel 7'], browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
    },
    {
      name: 'card',
      testMatch: 'card.spec.ts',
      dependencies: ['desktop', 'mobile'],
      use: { browserName: 'chromium', viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 },
    },
  ],
  reporter: 'line',
});
