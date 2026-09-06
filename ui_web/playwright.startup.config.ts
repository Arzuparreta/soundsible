import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Exercise the actual bundle produced by ui_build (or the engine's automatic
// rebuild locally). Vite dev has no external stylesheets or offline cache.
export default defineConfig({
  ...base,
  metadata: { startupProduction: true },
  testMatch: 'startup.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/player/',
    reuseExistingServer: false,
  },
});
