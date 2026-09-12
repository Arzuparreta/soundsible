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

/**
 * KNOWN FLAKE — fails roughly once per full-suite run on webkit-mobile, and has
 * done since before this test was written. It passes twelve times in twelve on
 * its own, however hard it is repeated; only whole-suite contention brings it
 * out, which points at the runner rather than at the app.
 *
 * The symptom moves — a search box reported missing, a button that never
 * settles, the snap helper's own `evaluate` timing out at thirty seconds — and
 * that last one is the tell: `snapPlayerCarousel` awaits a single
 * `requestAnimationFrame`, and WebKit stops delivering frames to a window it
 * considers occluded. Every symptom is then whatever the test reached for after
 * the hang.
 *
 * Four fixes have been measured against it and none held. Racing that frame
 * against a timer reads as the obvious answer and made the suite worse — eleven
 * failures in five runs against seven in four, and it pushed the scroll-restore
 * test below to four failures in five. Re-snapping until the tile aligns was
 * worse still: twelve of twelve on main became three failures in twelve.
 *
 * Written down rather than papered over: whoever picks this up should start
 * from why a fix that removes a real hang makes the runner less reliable, not
 * from a fresh guess at the symptom.
 *
 * A fifth fix has now been measured and did not hold either: `test.slow()`, on
 * the reading that the suite's 30s was simply too tight. Durations from three
 * full CI runs say otherwise — chromium-mobile 30048 -> 13482 pass, then 30049
 * / 30061 / 30059 all red, then, with a 90s budget, 90053 -> 14236 pass. The
 * first attempt takes whatever budget it is given and the retry finishes in
 * fourteen seconds, so the wait is unbounded rather than tight and a longer
 * budget only buys the hang more room. Reverted. webkit-desktop lands at ~32s
 * against either budget, which is its own 30s stall and not the test cap.
 *
 * What a failing attempt looks like, for whoever picks this up: the Radiohead
 * click below waits out the entire budget on `getByRole('link')` while
 * `getByRole('searchbox')` in the same panel resolves, and the error context
 * for that attempt has the link present, named, with the panel around it. So
 * the row renders and something keeps that one locator from matching it.
 * It reproduces locally at roughly one run in three with
 *
 *   CI=1 npx playwright test tests/browser/mobile-navigation.spec.ts \
 *     tests/browser/music-explorer.spec.ts --project=chromium-mobile
 *
 * and not at all when this file runs alone, so the test *before* it matters —
 * which is worth more than the runner-contention guess above. A probe that
 * polled that locator for six seconds at the failing point matched it six times
 * out of six, so the window is narrow.
 */
test('opens general music pages, preserves explorer search, and separates DJ references below Route', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openMusicPlayer(page);
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) await snapPlayerCarousel(page, 'now-playing', 'browser');
  let browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(browser.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
  await browser.getByRole('searchbox').fill('radiohead');
  await browser.getByRole('link', { name: /Radiohead/ }).click();
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/artist\/Radiohead/);
  await page.getByRole('link', { name: /In Rainbows/ }).click();
  await expect(page.getByText('15 Step', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Radiohead', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^NORMAL:/ }).click();
  if (mobile) await snapPlayerCarousel(page, 'now-playing', 'browser');
  await expect(browser.getByRole('searchbox')).toHaveValue('radiohead');
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  if (mobile) await snapPlayerCarousel(page, 'auto', 'browser');
  browser = page.locator('[data-auto-tile="browser"]');
  await expect(browser.getByRole('searchbox')).toHaveValue('radiohead');
  await browser.getByRole('link', { name: /Radiohead/ }).click();
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await page.getByRole('link', { name: /In Rainbows/ }).click();
  await expect(page.getByText('15 Step', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^DJ:/ }).click();
  if (mobile) await snapPlayerCarousel(page, 'auto', 'browser');
  await settle(page);
  await page.screenshot({ path: `/tmp/soundsible-music-${info.project.name}.png` });
  if (mobile) await snapPlayerCarousel(page, 'auto', 'route');
  const route = page.locator('[data-auto-tile="route"]');
  const references = route.getByRole('region', { name: 'Sesión' });
  await expect(references).toBeVisible();
  const refBox = await references.boundingBox();
  const routeBox = await route.boundingBox();
  expect(refBox!.height).toBeGreaterThan(70);
  expect(refBox!.y).toBeGreaterThan(routeBox!.y + routeBox!.height / 2);
  await references.getByRole('button', { name: 'Mezclar con…', exact: true }).click();
  if (mobile) await expect(browser).not.toHaveAttribute('inert', '');
  await expect(browser.getByText('Mezclar con la sesión', { exact: true }).first()).toBeVisible();
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
