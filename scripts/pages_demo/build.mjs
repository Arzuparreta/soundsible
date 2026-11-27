// Load Vite from the release player's locked dependencies.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../ui_web/package.json', import.meta.url));
const { build } = await import(pathToFileURL(require.resolve('vite')));
const source = fileURLToPath(new URL('../../ui_web/src/', import.meta.url));
const transport = fileURLToPath(new URL('./transport.js', import.meta.url));
await build({
  base: './',
  build: { outDir: process.argv[2] },
  plugins: [{
    name: 'static-demo-transport',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!importer || !id.endsWith('/media') || importer.startsWith('\0')) return;
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved?.id === source + 'lib/media.ts') return '\0demo-media';
    },
    load(id) {
      if (id !== '\0demo-media') return;
      return `
        export * from ${JSON.stringify(source + 'lib/media.ts')};
        export const streamUrl = id => new URL(encodeURIComponent(id) + '.wav', document.baseURI).href;
        export const coverUrl = () => new URL('cover.svg', document.baseURI).href;
        export const trackCoverUrl = coverUrl;
      `;
    },
    transform(code, id) {
      if (id !== source + 'main.tsx') return;
      return `import { setRequestTransport } from './lib/http';
        import { demoRequest } from ${JSON.stringify(transport)};
        setRequestTransport(demoRequest);
        ` + code;
    },
  }],
});
