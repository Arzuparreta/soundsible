import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

/** The library's songs: the shared row, artwork and search field, as every
 * list in the app draws them. */
async function songsView(page: Page) {
  await page.goto('/player/#/library?view=songs');
  const list = page.locator('[data-primary-scroll]:visible').first();
  await expect(list.locator('[data-song-row], [data-music-list-row]').first()).toBeVisible();
  await page.evaluate(async () => {
    const fonts = await document.fonts.load('400 16px "Plus Jakarta Sans"');
    if (!fonts.length) throw new Error('The Soundsible UI font is unavailable');
    await document.fonts.ready;
  });
  return list;
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/static/cover/**', route => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#35456d"/><circle cx="80" cy="80" r="48" fill="#a3b6cf"/></svg>' }));
});

for (const theme of ['dark', 'light']) for (const size of ['compact', 'normal', 'large']) {
  test(`library rows keep their density and row actions: ${theme}, ${size}`, async ({ page, isMobile }) => {
    const list = await songsView(page);
    await page.evaluate(({ theme, size }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.interfaceSize = size;
    }, { theme, size });
    const row = list.locator('[data-song-row], [data-music-list-row]').first();
    const menu = row.locator('[data-row-menu], button[aria-label="Más opciones"]');
    await expect(menu).toBeVisible();
    const metrics = await row.evaluate(element => ({ height: element.getBoundingClientRect().height,
      expected: parseFloat(getComputedStyle(element).getPropertyValue('--row-h')) }));
    expect(metrics.height).toBeCloseTo(metrics.expected, 0);
    const cover = await row.locator('[data-artwork-surface]').evaluate(element => ({ height: element.getBoundingClientRect().height,
      expected: parseFloat(getComputedStyle(element).getPropertyValue('--cover-sm')) }));
    expect(cover.height).toBeCloseTo(cover.expected, 0);
    // A phone reveals the filter with a pull; the desktop shows it under the title.
    if (!isMobile) {
      // The shared SearchField box, border included, is what follows the density.
      const field = await page.locator('input[type="search"]:visible').first().evaluate(element => ({ height: element.parentElement!.getBoundingClientRect().height,
        expected: parseFloat(getComputedStyle(element).getPropertyValue('--control-h')) }));
      expect(field.height).toBeCloseTo(field.expected, 0);
    }
    await expect(list).toHaveScreenshot(`library-${theme}-${size}.png`);
  });
}

test('Shift+F10 anchors the row menu to the focused control and restores focus', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the coarse pointer uses the shared action sheet');
  const list = await songsView(page);
  const opener = list.getByRole('button', { name: /^Reproducir Canción de biblioteca/ }).first();
  await opener.focus();
  await opener.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  const [anchor, box] = [await opener.boundingBox(), await menu.boundingBox()];
  expect(Math.abs(box!.x - anchor!.x)).toBeLessThan(10);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(opener).toBeFocused();
});
