import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import solid from 'vite-plugin-solid';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const root = __dirname;

/**
 * Production: multi-page build.
 *   - index.html / desktop.html  → legacy vanilla player (served at /player/, /player/desktop/)
 *   - app.html                   → new SolidJS player (served at /player/app.html) during the rebuild
 * Dev: `npm run dev` — proxies /api and Socket.IO to the Flask server (see server.proxy).
 */
export default defineConfig(({ command }) => ({
  root,
  base: '/player/',
  publicDir: false,
  plugins: [solid()],
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        desktop: resolve(root, 'desktop.html'),
        app: resolve(root, 'app.html'),
      },
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
