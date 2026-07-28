import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 960, height: 640 },
    locale: 'en-US',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'npm run frontend:dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
});
