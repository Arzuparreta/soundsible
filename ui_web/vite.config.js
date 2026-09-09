import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import solid from 'vite-plugin-solid';
import { startupScreen } from './src/boot/plugin';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const root = __dirname;

// Content identity works in Docker too, where .git is deliberately absent.
function playbackSourceRevision() {
  const hash = createHash('sha256');
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else { hash.update(path.slice(root.length)); hash.update(readFileSync(path)); }
    }
  };
  visit(resolve(root, 'src'));
  hash.update(readFileSync(resolve(root, 'package-lock.json')));
  hash.update(readFileSync(resolve(root, 'vite.config.js')));
  return hash.digest('hex');
}

/**
 * Single SolidJS player for every surface. In production Flask serves the
 * generated dist/index.html from /player/ and /player/desktop/.
 * Dev: `npm run dev` proxies /api and Socket.IO to the Flask server.
 */
export default defineConfig(({ command }) => ({
  root,
  base: '/player/',
  define: { __PLAYBACK_SOURCE_REVISION__: JSON.stringify(command === 'build' ? playbackSourceRevision() : 'development-unverified') },
  // Copied verbatim to dist/ (stable names, no hashing) so the manifest and its
  // icons keep predictable URLs — a .webmanifest can't reference hashed assets.
  publicDir: resolve(root, 'public'),
  plugins: [solid(), startupScreen()],
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, 'index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (id.includes('node_modules/socket.io-client')) return 'vendor-socket';
        },
      },
    },
  },
  server: command === 'serve'
    ? {
        port: 5173,
        strictPort: true,
        proxy: {
          '/api': { target: 'http://127.0.0.1:5005', changeOrigin: true },
          '/socket.io': { target: 'http://127.0.0.1:5005', ws: true, changeOrigin: true },
        },
      }
    : undefined,
}));
