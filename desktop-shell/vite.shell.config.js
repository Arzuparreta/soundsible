import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./shell-ui', import.meta.url)),
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./shell-ui-dist', import.meta.url)),
    emptyOutDir: true,
  },
});
