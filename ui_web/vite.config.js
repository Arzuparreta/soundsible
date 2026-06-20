import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import solid from 'vite-plugin-solid';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const root = __dirname;

/**
 * Single SolidJS player for every surface. In production Flask serves the
 * generated dist/index.html from /player/ and /player/desktop/.
 * Dev: `npm run dev` proxies /api and Socket.IO to the Flask server.
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
