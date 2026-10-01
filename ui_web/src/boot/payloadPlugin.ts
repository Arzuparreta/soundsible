import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import type { Plugin } from 'vite';

/** Build once, serve compressed bytes without doing compression on requests. */
export function payloadAssets(buildId: string): Plugin {
  let output = '';
  return {
    name: 'soundsible-payload-assets',
    configResolved(config) { output = resolve(config.root, config.build.outDir); },
    transformIndexHtml: {
      order: 'post',
      handler: html => html.replace('</head>', `<meta name="soundsible-build" content="${buildId}"></head>`),
    },
    closeBundle() {
      if (!output) return;
      const html = readFileSync(resolve(output, 'index.html'), 'utf8');
      const core = [...new Set([...html.matchAll(/(?:src|href)="\/player\/(assets\/[^" ]+\.(?:js|css))"/g)].map(match => '/player/' + match[1]))];
      const assets: Record<string, number> = {};
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (/\.(?:js|css|svg|png|ico|woff2?|webmanifest)$/.test(entry.name)) {
            assets['/player/' + relative(output, path).replaceAll('\\', '/')] = readFileSync(path).byteLength;
          }
        }
      };
      visit(output);
      const worker = resolve(output, 'sw.js');
      const template = readFileSync(worker, 'utf8');
      writeFileSync(worker, template
        .replace('__BUILD_ID__', buildId)
        .replace('__CORE_ASSETS__', JSON.stringify(core))
        .replace('__ASSET_SIZES__', JSON.stringify(assets)));
      const compress = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) compress(path);
          else if (/\.(?:js|css|svg|html|json|webmanifest)$/.test(entry.name)) {
            const bytes = readFileSync(path);
            if (bytes.length < 1024) continue;
            for (const [suffix, compressed] of [
              ['gz', gzipSync(bytes, { level: 9 })],
              ['br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })],
            ] as const) {
              if (compressed.length < bytes.length) writeFileSync(path + '.' + suffix, compressed);
            }
          }
        }
      };
      compress(output);
    },
  };
}
