import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

async function browserPanel(page: Page, mobile: boolean) {
  await openMusicPlayer(page);
  if (mobile) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').first().tap();
  }
  const browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(browser).not.toHaveAttribute('inert', '');
  await expect(browser.locator('[data-song-row], [data-music-list-row]').first()).toBeVisible();
  await page.evaluate(async () => {
    const fonts = await document.fonts.load('400 16px "Plus Jakarta Sans"');
    if (!fonts.length) throw new Error('The Soundsible UI font is unavailable');
    await document.fonts.ready;
  });
  return browser;
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/static/cover/**', route => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#35456d"/><circle cx="80" cy="80" r="48" fill="#a3b6cf"/></svg>' }));
});

for (const theme of ['dark', 'light']) for (const size of ['compact', 'normal', 'large']) {
  test(`the player browser keeps its density and row actions: ${theme}, ${size}`, async ({ page, isMobile }) => {
    const browser = await browserPanel(page, isMobile);
    await page.evaluate(({ theme, size }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.interfaceSize = size;
    }, { theme, size });
    const row = browser.locator('[data-song-row], [data-music-list-row]').first();
    const menu = row.locator('[data-row-menu], button[aria-label="Más opciones"]');
    await expect(menu).toBeVisible();
    const metrics = await row.evaluate(element => ({ height: element.getBoundingClientRect().height,
      expected: parseFloat(getComputedStyle(element).getPropertyValue('--row-h')) }));
    expect(metrics.height).toBeCloseTo(metrics.expected, 0);
    const cover = await row.locator('[data-artwork-surface]').evaluate(element => ({ height: element.getBoundingClientRect().height,
      expected: parseFloat(getComputedStyle(element).getPropertyValue('--cover-sm')) }));
    expect(cover.height).toBeCloseTo(cover.expected, 0);
    const field = await browser.locator('input[type="search"]').evaluate(element => ({ height: element.getBoundingClientRect().height,
      expected: parseFloat(getComputedStyle(element).getPropertyValue('--control-h')) }));
    expect(field.height).toBeCloseTo(field.expected, 0);
    await expect(browser).toHaveScreenshot(`browser-${theme}-${size}.png`);
  });
}

test('Shift+F10 anchors the row menu to the focused control and restores focus', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the coarse pointer uses the shared action sheet');
  const browser = await browserPanel(page, false);
  const opener = browser.getByRole('button', { name: /^Reproducir Canción de biblioteca/ }).first();
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

test('browser tabs have one keyboard stop and arrow activation', async ({ page, isMobile }) => {
  const browser = await browserPanel(page, isMobile);
  const tabs = browser.getByRole('tablist', { name: 'Biblioteca' });
  const songs = tabs.getByRole('tab', { name: 'Canciones', exact: true });
  await songs.focus();
  await songs.press('End');
  await expect(tabs.getByRole('tab', { name: 'Artistas', exact: true })).toBeFocused();
  await expect(tabs.getByRole('tab', { selected: true })).toHaveText('Artistas');
  await page.keyboard.press('Home');
  await expect(songs).toBeFocused();
  await expect(songs).toHaveAttribute('aria-selected', 'true');
  const panel = browser.getByRole('tabpanel', { name: 'Canciones', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-labelledby', (await songs.getAttribute('id'))!);
});
