import { expect, test, type Locator } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({ json: {
    tracks: TRACKS, playlists: { 'Lista de prueba': TRACKS.slice(0, 3).map((track) => track.id) },
    settings: {}, podcast_subscriptions: [],
  } }));
  await page.route('**/api/library/saved-entities', (route) => route.fulfill({ json: { entities: [
    { kind: 'album', name: 'In Rainbows', artist: 'Radiohead', destination: '/album/In%20Rainbows?deezer_id=2' },
    { kind: 'artist', name: 'Radiohead', destination: '/artist/Radiohead?deezer_id=1' },
  ] } }));
});

/** The artwork of every row: the one element carrying the cover background. */
async function coverBoxes(list: Locator) {
  return list.evaluate((root) => [...root.querySelectorAll<HTMLElement>('*')]
    .filter((element) => getComputedStyle(element).backgroundImage.includes('gradient'))
    .map((element) => element.getBoundingClientRect())
    .map(({ width, height }) => ({ width, height })));
}

// The artwork is the row's placeholder too: a cover that never loads still
// draws its gradient. A box with no height draws neither, and reads as rows
// that lost their pictures.
for (const [section, title] of [['Listas', 'Lista de prueba'], ['Guardados', 'In Rainbows']] as const) {
  test(`${section} rows in the Now Playing browser show their artwork`, async ({ page }) => {
    await openMusicPlayer(page);
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.locator('[data-player-surface-open] nav[data-no-surface-swipe]').getByRole('button').first().click();
    }
    const browser = page.locator('[data-now-playing-tile="browser"]');
    await browser.getByRole('navigation').getByRole('button', { name: section, exact: true }).click();
    await expect(browser.getByText(title, { exact: true })).toBeVisible();
    const body = browser.locator('[data-browser-body]');
    await expect.poll(async () => (await coverBoxes(body)).length).toBeGreaterThan(0);
    for (const box of await coverBoxes(body)) {
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.height).toBe(box.width);
    }
  });
}
