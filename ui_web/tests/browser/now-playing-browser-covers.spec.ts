import { expect, test, type Locator } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, searchPlayerPanel, TRACKS } from './music-browser-fixture';

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({ json: {
    tracks: TRACKS, playlists: { 'Lista de prueba': TRACKS.slice(0, 3).map((track) => track.id) },
    settings: {}, podcast_subscriptions: [],
  } }));
});

/** The artwork of every row: either a visible decoded `<img>` or its fallback gradient. */
async function coverBoxes(list: Locator) {
  return list.evaluate((root) => [...root.querySelectorAll<HTMLElement>('[data-artwork-surface]')]
    .filter((element) => {
      const img = element.querySelector('img');
      const hasLoadedImg = !!img && img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity !== '0';
      return hasLoadedImg || getComputedStyle(element).backgroundImage.includes('gradient');
    })
    .map((element) => element.getBoundingClientRect())
    .map(({ width, height }) => ({ width, height })));
}

// The artwork is the row's placeholder too: a cover that never loads still
// draws its gradient. A box with no height draws neither, and reads as rows
// that lost their pictures.
test('collection tiles and search rows in the player search panel show their artwork', async ({ page }) => {
  await openMusicPlayer(page);
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe]').getByRole('button').first().click();
  }
  const browser = page.locator('[data-now-playing-tile="browser"]');
  const body = browser.locator('[data-browser-body]');
  const check = async () => {
    await expect.poll(async () => (await coverBoxes(body)).length).toBeGreaterThan(0);
    for (const box of await coverBoxes(body)) {
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.height).toBe(box.width);
    }
  };
  await expect(browser.getByRole('button', { name: 'Reproducir: Lista de prueba', exact: true })).toBeVisible();
  await check();
  await searchPlayerPanel(browser, 'Canción', false);
  await check();
});
