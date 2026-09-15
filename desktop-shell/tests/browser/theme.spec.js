import { expect, test } from '@playwright/test';

import { THEMES, THEME_COLORS } from '../../../ui_web/src/boot/themes';
import { mockTauri } from './tauri-mock.js';

/*
 * The shell paints the window a listener meets first — first run, engine
 * starting, engine failed — and it used to paint it dark whatever they chose.
 *
 * Rust resolves the palette and hands the name over; everything after that is
 * this stylesheet, so this is where it is checked: the surfaces move, the ink
 * stays readable on them, and the background is the one the player hands off to.
 */

/** The dark palette is the bare :root, so it has no [data-theme] of its own. */
const PAINTED = THEMES.filter((theme) => theme !== 'system');

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const rgb = (value) => value.match(/\d+/g).slice(0, 3).map(Number);
const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));

for (const theme of PAINTED) {
  test(`${theme}: the shell paints the palette the player chose`, async ({ page }) => {
    await mockTauri(page, { get_shell_theme: theme });
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const painted = await page.locator('body').evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, ink: style.color };
    });
    // The handoff into the webview must not be a colour change.
    expect(rgb(painted.background)).toEqual(hex(THEME_COLORS[theme]));
    expect(contrast(rgb(painted.ink), rgb(painted.background))).toBeGreaterThanOrEqual(4.5);

    await page.screenshot({ animations: 'disabled', path: `test-results/shell-${theme}.png` });
  });
}

test('an answer the shell cannot use leaves it on the default palette', async ({ page }) => {
  // Rust only ever sends a palette it has a colour for, but the bridge can also
  // fail outright — and a shell with no first-run screen is worse than a dark one.
  await mockTauri(page, { get_shell_theme: null });
  await page.goto('/');

  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.getByRole('button', { name: 'Choose folder…' })).toBeVisible();
});
