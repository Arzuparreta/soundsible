import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** Inline the tiny launch surface in both dev and production. It must not need
 * another request, the Solid runtime, or a locale chunk to paint. Keep these
 * inputs under src/ so ensure_ui_dist also detects edits to the boot screen. */
export function startupScreen(): Plugin {
  return {
    name: 'soundsible-startup-screen',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        let styles = 0;
        // Vite emits these links after transforming the entry module. Fetch at
        // normal priority, but only apply on load: ordinary stylesheet links
        // would block even our inline splash from painting on a slow network.
        html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (link) => {
          styles++;
          const preload = link.replace('rel="stylesheet"', 'rel="preload" as="style"');
          const deferred = link.replace('rel="stylesheet"',
            'rel="stylesheet" media="print" data-boot-style ' +
            'onload="window.__SOUNDSIBLE_BOOT__.styleLoaded(this)" ' +
            'onerror="window.__SOUNDSIBLE_BOOT__.fail()"');
          return `${preload}\n${deferred}`;
        });

        const logo = Buffer.from(read('../../../branding/logo-mark.svg')).toString('base64');
        const script = read('./startup.js').replace('__BOOT_STYLE_COUNT__', String(styles));
        return html
          .replace('<!-- soundsible:boot-head -->',
            `<style>${read('./startup.css')}</style>\n<script>${script}</script>`)
          .replace('<!-- soundsible:boot-screen -->',
            read('./startup.html').replace('__BOOT_LOGO__', `data:image/svg+xml;base64,${logo}`));
      },
    },
  };
}
