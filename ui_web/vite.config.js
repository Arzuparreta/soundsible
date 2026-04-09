import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const root = __dirname;

/**
 * Production: multi-page build for /player/ and /player/desktop/
 * Dev: `npm run dev` — proxies /api and Socket.IO to the Flask server (see server.proxy).
 */
export default defineConfig(({ command }) => ({
  root,
  base: '/player/',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        desktop: resolve(root, 'desktop.html'),
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
