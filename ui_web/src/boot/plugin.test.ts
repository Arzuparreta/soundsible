import { describe, expect, it } from 'vitest';

import { startupScreen, themeBootScript } from './plugin';
import { THEME_COLORS } from './themes';

/* The boot surface is the one place the palette cannot be read from the token
   stylesheet — it paints before that stylesheet loads. So it is written in from
   the same table the app uses, and these are the seams where that happens. */

const MARKERS = [
  '<html lang="en" data-theme="dark" data-booting><head>',
  '<!-- soundsible:boot-theme --><!-- soundsible:boot-head -->',
  '</head><body><!-- soundsible:boot-screen --></body></html>',
].join('');

function transform(html = MARKERS): string {
  const hook = startupScreen().transformIndexHtml as { handler: (html: string) => string };
  return hook.handler(html);
}

describe('boot plugin', () => {
  it('paints a first-paint background for every theme the boot script can stamp', () => {
    const html = transform();
    for (const [theme, background] of Object.entries(THEME_COLORS)) {
      expect(html).toContain(`html[data-booting][data-theme='${theme}'], html[data-booting][data-theme='${theme}'] body { background: var(--custom-bg-base, ${background}); }`);
    }
    expect(html).not.toContain('__THEME_BACKGROUNDS__');
  });

  it('inlines the pre-paint theme script with nothing left to substitute', () => {
    expect(themeBootScript()).not.toMatch(/__[A-Z_]+__/);
    expect(transform()).toContain(themeBootScript());
  });

  it('leaves non-player HTML such as tv.html untouched without the phone splash', () => {
    const tvHtml = '<html lang="en" data-surface="tv"><head></head><body><div id="tv-boot-screen"></div></body></html>';
    expect(transform(tvHtml)).toBe(tvHtml);
  });

  it('injects window.soundsibleBootColors for tv.html without loading the player boot splash', () => {
    const tvShell = '<html lang="en" data-surface="tv"><head><!-- soundsible:tv-boot-colors --></head><body><div id="tv-boot-screen"></div></body></html>';
    const out = transform(tvShell);
    expect(out).toContain('window.soundsibleBootColors');
    expect(out).not.toContain('id="boot-screen"');
  });
});
