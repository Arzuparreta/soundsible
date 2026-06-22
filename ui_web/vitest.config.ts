import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Separate from vite.config.js so the production build stays untouched. Solid
// needs the 'development'/'browser' export conditions to load its DOM runtime
// (not the SSR build) under jsdom.
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { '@': resolve(root, 'src') },
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
