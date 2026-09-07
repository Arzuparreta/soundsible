import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';
import { snapPlayerCarousel } from './playerGestures';
import { settle } from './settle';

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/search?**', (route) => route.fulfill({ json: {
    items: [{ id: 'artist:1', type: 'artist', source: 'deezer', title: 'Radiohead', artist: 'Radiohead' }],
    sections: [{ id: 'artists', item_ids: ['artist:1'] }],
  } }));
  await page.route('**/api/catalog/artist?**', (route) => route.fulfill({ json: {
    name: 'Radiohead', top_tracks: [], albums: [{ title: 'In Rainbows', deezer_id: 'album:1', year: 2007 }], singles_eps: [], related_artists: [],
  } }));
  await page.route('**/api/catalog/album?**', (route) => route.fulfill({ json: {
    title: 'In Rainbows', tracklist: [{ id: 'youtube:1', source: 'youtube', type: 'track', title: '15 Step', artist: 'Radiohead', raw: { id: 'yt-song' } }],
  } }));
  await page.route('**/api/discovery/music/dj-plan', (route) => route.fulfill({ json: {
    items: TRACKS.slice(0, 8).map((row) => ({ ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}` })),
    requests: [], pool_counts: {},
  } }));
});

test('explores inside the shell, restores search, and separates DJ references below Route', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openMusicPlayer(page);
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) await snapPlayerCarousel(page, 'now-playing', 'browser');
  let browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(browser.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
  await browser.getByRole('searchbox').fill('radiohead');
  await browser.getByRole('button', { name: /Radiohead/ }).click();
  await browser.getByRole('button', { name: /In Rainbows/ }).click();
  await expect(browser.getByText('15 Step', { exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'Volver', exact: true }).click();
  await browser.getByRole('button', { name: 'Volver', exact: true }).click();
  await expect(browser.getByRole('searchbox')).toHaveValue('radiohead');
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  if (mobile) await snapPlayerCarousel(page, 'auto', 'browser');
  browser = page.locator('[data-auto-tile="browser"]');
  await expect(browser.getByRole('searchbox')).toHaveValue('radiohead');
  await browser.getByRole('button', { name: /Radiohead/ }).click();
  await browser.getByRole('button', { name: /In Rainbows/ }).click();
  await expect(browser.getByRole('button', { name: 'Pedir: 15 Step', exact: true })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `/tmp/soundsible-music-${info.project.name}.png` });
  if (mobile) await snapPlayerCarousel(page, 'auto', 'route');
  const route = page.locator('[data-auto-tile="route"]');
  const references = route.getByRole('region', { name: 'Referencias de la sesión' });
  await expect(references).toBeVisible();
  const refBox = await references.boundingBox();
  const routeBox = await route.boundingBox();
  expect(refBox!.height).toBeGreaterThan(70);
  expect(refBox!.y).toBeGreaterThan(routeBox!.y + routeBox!.height / 2);
  await references.getByRole('button', { name: 'Añadir referencia', exact: true }).click();
  if (mobile) await expect(browser).not.toHaveAttribute('inert', '');
  await expect(browser.getByText('Elige música para orientar la sesión')).toBeVisible();
  await browser.getByRole('button', { name: 'Cancelar selección', exact: true }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  if (mobile) await snapPlayerCarousel(page, 'auto', 'route');
  await settle(page);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `/tmp/soundsible-route-${info.project.name}.png` });
});


test('restores the library scroll after changing section and player mode', async ({ page }) => {
  await openMusicPlayer(page);
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) await snapPlayerCarousel(page, 'now-playing', 'browser');
  const normal = page.locator('[data-now-playing-tile="browser"]');
  const body = normal.locator('[data-browser-body]');
  await expect(normal.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
  await body.evaluate((element) => { element.scrollTop = 1400; });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(1400);
  await normal.getByRole('button', { name: 'Favoritos', exact: true }).click();
  await normal.getByRole('button', { name: 'Biblioteca', exact: true }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(1400);
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  if (mobile) await snapPlayerCarousel(page, 'auto', 'browser');
  const djBody = page.locator('[data-auto-tile="browser"] [data-browser-body]');
  await expect.poll(() => djBody.evaluate((element) => element.scrollTop)).toBe(1400);
});
