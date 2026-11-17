import { defineConfig } from '@playwright/test';
import base, { closedEngine } from './playwright.config';

const startupSpecs = ['startup.spec.ts', 'dj-shell-loading.spec.ts'];

// Exercise the actual bundle produced by ui_build (or the engine's automatic
// rebuild locally). Vite dev has no external stylesheets or offline cache.
export default defineConfig({
  ...base,
  metadata: { startupProduction: true },
  testMatch: startupSpecs,
  // A compatibility project's own testMatch overrides the top-level matcher.
  // Every engine here must run startup contracts, not its separate UI suite.
  projects: base.projects?.map(project => ({ ...project, testMatch: startupSpecs })),
  use: { ...base.use, baseURL: 'http://127.0.0.1:4174' },
  // Docker WebKit uses the host preview over a read-only repository mount.
  webServer: process.env.SOUNDSIBLE_UI_PREVIEW_EXTERNAL ? undefined : {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/player/',
    reuseExistingServer: false,
    env: { SOUNDSIBLE_DEV_ENGINE: closedEngine },
  },
});
