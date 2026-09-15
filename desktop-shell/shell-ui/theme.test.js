import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { THEMES, THEME_COLORS } from '../../ui_web/src/boot/themes';

/*
 * The shell paints its own first-run, loading and error screens, from its own
 * stylesheet, in its own origin. Nothing at build time ties that stylesheet to
 * the player's themes — so a palette added to the player would simply not
 * arrive here, and the only symptom would be a shell that stayed dark while
 * everything else went green.
 *
 * These read the two files against each other instead.
 */

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The custom properties a selector's top-level block declares. */
function tokensOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(styles);
  if (!block) return null;
  const tokens = {};
  for (const [, name, value] of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const base = tokensOf(':root');
/** Dark is the bare :root block; `system` is never stamped on the document. */
const overrides = THEMES.filter((theme) => theme !== 'dark' && theme !== 'system');

describe('shell palettes', () => {
  it('knows the player is there at all', () => {
    expect(Object.keys(THEME_COLORS).length).toBeGreaterThan(1);
    expect(base).not.toBeNull();
  });

  it.each(overrides)('has a palette for %s', (theme) => {
    const tokens = tokensOf(`[data-theme="${theme}"]`);
    expect(tokens, `styles.css declares no [data-theme="${theme}"] block`).not.toBeNull();
    expect(Object.keys(tokens).length).toBeGreaterThan(0);
    // A token :root never declares overrides nothing — it is a typo that no
    // amount of looking at the shell would reveal.
    for (const name of Object.keys(tokens)) {
      expect(base, `${theme} declares ${name}, which :root does not`).toHaveProperty(name);
    }
    // Every palette has to repaint the surface the window background is set to.
    expect(tokens, `${theme} leaves the shell on the dark background`).toHaveProperty('--bg-base');
  });

  it('hands off to the player without a colour change', () => {
    // DESIGN.md: the shell background must match the player's, or the moment
    // the webview navigates is a visible flicker between two near-blacks.
    expect(base['--bg-base']).toBe(THEME_COLORS.dark);
    for (const theme of overrides) {
      if (theme === 'system') continue;
      expect(tokensOf(`[data-theme="${theme}"]`)['--bg-base']).toBe(THEME_COLORS[theme]);
    }
  });
});
