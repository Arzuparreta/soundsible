import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import solid from 'vite-plugin-solid';
import { startupScreen } from './src/boot/plugin';

// Same HTML/theme/launch surface, with a native entry that never boots the
// same-origin browser session. The server bundle and its /player/ SW are separate.
const metadata = JSON.parse(readFileSync(new URL('../android/build-info.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __ANDROID_SOURCE_REVISION__: JSON.stringify(metadata.source_revision) },
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [
    {
      name: 'soundsible-android-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html
          .replace('/src/main.tsx', '/src/mobile/main.tsx')
          .replace(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g, ''),
      },
    },
    solid(), startupScreen(),
  ],
  build: {
    outDir: '../android/web-dist',
    emptyOutDir: true,
    target: 'chrome120',
  },
});
