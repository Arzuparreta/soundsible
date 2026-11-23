import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';
import { settle } from './settle';

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/discovery/music/dj-plan', (route) => route.fulfill({ json: {
    items: TRACKS.slice(0, 8).map((row) => ({ ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}` })),
    requests: [], pool_counts: {},
  } }));
});

const compact = (page: Page) => page.locator('[data-player-surface-open][data-compact]').count().then(Boolean);

/** The route panel, through the same pager the listener uses. */
async function showRoute(page: Page) {
  if (await compact(page)) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(1).click();
  }
  const route = page.locator('[data-auto-tile="route"]');
  await expect(route).not.toHaveAttribute('inert', '');
  return route;
}

async function openDj(page: Page) {
  await openMusicPlayer(page);
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  await expect(page.locator('#auto-mode-view [data-player-tile="stage"]')).toBeVisible();
  return showRoute(page);
}

test('Mix with… waits for music chosen in the app, and the pick joins the session', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const route = await openDj(page);
  const session = route.getByRole('region', { name: 'Sesión' });
  await expect(session).toBeVisible();
  // The session's sources sit under the route, not over it.
  const [sessionBox, routeBox] = [await session.boundingBox(), await route.boundingBox()];
  expect(sessionBox!.height).toBeGreaterThan(70);
  expect(sessionBox!.y).toBeGreaterThan(routeBox!.y + routeBox!.height / 2);

  await session.getByRole('button', { name: 'Mezclar con…', exact: true }).click();
  const banner = page.locator('[data-dj-errand]');
  await expect(banner).toContainText('Elige música para mezclar con la sesión');
  // The app is where the music is chosen: beside the player on a desktop, in
  // place of it on a phone.
  if (info.project.name.includes('mobile')) await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  else await expect(page.locator('[data-player-surface-open]')).toHaveAttribute('data-docked', '');

  await page.locator('#app').getByRole('button', { name: /Reproducir Canción de biblioteca 319/ }).click();
  await expect(banner).toHaveCount(0);
  // It became a source; it did not start a new session or play.
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  await expect((await showRoute(page)).getByRole('region', { name: 'Sesión' })).toContainText('Canción de biblioteca 319');
  await expect(page.locator('#auto-mode-view [data-player-tile="stage"]')).toContainText('Canción de biblioteca 320');
  await settle(page);
  expect(errors).toEqual([]);
});

test('a cancelled errand leaves the next play a play again', async ({ page }, info) => {
  const route = await openDj(page);
  await route.getByRole('region', { name: 'Sesión' }).getByRole('button', { name: 'Mezclar con…', exact: true }).click();
  const banner = page.locator('[data-dj-errand]');
  await banner.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  // A phone's player is back over the app; beside it, the app is still there.
  test.skip(info.project.name.includes('mobile'), 'the phone player covers the app again');
  // With DJ on, playing a song starts a new session from it.
  await page.locator('#app').getByRole('button', { name: /Reproducir Canción de biblioteca 319/ }).click();
  await expect(page.locator('#auto-mode-view [data-player-tile="stage"]')).toContainText('Canción de biblioteca 319', { timeout: 15_000 });
});
