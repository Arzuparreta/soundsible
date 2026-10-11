import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, restoreQueueSession, TRACKS } from './music-browser-fixture';

/** A song the DJ found outside the library: in the route, not yet kept. */
const FOUND = { id: 'routeSong01', youtube_id: 'routeSong01', title: 'Canción encontrada', artist: 'Artista externo', duration: 200 };

async function routeSong(page: Page, alreadySaved = false) {
  await mockMusicEngine(page);
  await page.route((url) => url.pathname === '/api/library/saved', (route) => route.fulfill({ json: {
    saved: alreadySaved ? [{ keys: [`yt:${FOUND.id}`], title: FOUND.title, artist: FOUND.artist }] : [],
  } }));
  await page.route('**/api/discovery/music/dj-plan', (route) => route.fulfill({ json: {
    items: [
      { ...FOUND, source_pool: 'related', recommendation_identity: `music:yt:${FOUND.id}` },
      ...TRACKS.slice(-4).map((row) => ({ ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}` })),
    ],
    requests: [], pool_counts: {},
  } }));
  await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({ json: {
    // Row actions need a playing song and a short route, not the fixture's
    // 320-song queue. Large-queue scrolling has its own browser coverage.
    tracks: TRACKS.slice(-5), playlists: { Pruebas: [] }, settings: {}, podcast_subscriptions: [],
  } }));
  const saved: Array<{ entry: { keys: string[] } }> = [];
  await page.route('**/api/library/saved/toggle', async (route) => {
    saved.push(route.request().postDataJSON());
    await route.fulfill({ json: { is_saved: true } });
  });
  const favourites: Array<{ favourite: { keys: string[] } }> = [];
  await page.route('**/api/library/favourites/toggle', async (route) => {
    favourites.push(route.request().postDataJSON());
    await route.fulfill({ json: { is_favourite: true } });
  });
  const playlist: Array<{ track_id: string }> = [];
  await page.route('**/api/library/playlists/Pruebas/tracks', async (route) => {
    const body = route.request().postDataJSON();
    playlist.push(body);
    await route.fulfill({ json: { playlists: { Pruebas: [body.track_id] } } });
  });
  const enqueued: Array<{ items: Array<{ video_id?: string }> }> = [];
  await page.route((url) => url.pathname === '/api/downloader/queue', async (route) => {
    if (route.request().method() === 'POST') {
      enqueued.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'ok', ids: ['download-1'] } });
      return;
    }
    await route.fulfill({ json: { queue: [], is_processing: false, logs: [] } });
  });

  // Restore the playing context and arrange DJ through the real store. These
  // tests exercise row menus; starting DJ through its tab is covered separately.
  await restoreQueueSession(page, { current: TRACKS[319], requests: [], context: TRACKS.slice(-5, -1) });
  await page.goto('/player/#/library?view=songs');
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/player/src/stores/index.ts';
    const { state } = await import(/* @vite-ignore */ modulePath);
    return state.playback.currentTrack?.id;
  })).toBe(TRACKS[319].id);
  await page.evaluate(async () => {
    const modulePath = '/player/src/stores/index.ts';
    const { actions } = await import(/* @vite-ignore */ modulePath);
    actions.enterAutoMode();
  });
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(2).click();
  const route = page.locator('[data-auto-tile="route"]');
  const row = route.locator('[data-drag-row]').filter({ hasText: FOUND.title });
  await expect(row).toBeVisible();

  return { row, saved, favourites, playlist, enqueued };
}

// Each user action has its own fixture and budget. Combining four modal flows
// made the final action inherit almost no time on software-rendered WebKit.
test('a song the DJ found is saved from its route row without route-only actions', async ({ page }) => {
  const { row, saved } = await routeSong(page);
  await row.locator('[data-row-menu]').click();
  const menu = page.getByRole('dialog');
  await expect(menu.getByText('Guardar en tu biblioteca', { exact: true })).toBeVisible();
  await expect(menu.getByText('Añadir a playlist', { exact: true })).toBeVisible();
  await expect(menu.getByText('Eliminar de la biblioteca', { exact: true })).toHaveCount(0);
  await expect(menu.getByText('Reproducir ahora', { exact: true })).toHaveCount(0);
  await menu.getByText('Guardar en tu biblioteca', { exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].entry.keys).toContain(`yt:${FOUND.id}`);
  await expect(row).toBeVisible();
});

test('a song the DJ found can be favourited without leaving its route row', async ({ page }) => {
  // Favourites are offered once the found song has been saved.
  const { row, favourites } = await routeSong(page, true);
  await row.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByText('Añadir a favoritos', { exact: true }).click();
  await expect.poll(() => favourites.length).toBe(1);
  expect(favourites[0].favourite.keys).toContain(`yt:${FOUND.id}`);
  await expect(row).toBeVisible();
});

test('a song the DJ found can join a playlist without leaving its route row', async ({ page }) => {
  const { row, playlist } = await routeSong(page);
  await row.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByText('Añadir a playlist', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Pruebas/ }).click();
  await expect.poll(() => playlist).toEqual([{ track_id: FOUND.id }]);
  await expect(row).toBeVisible();
});

test('a song the DJ found is downloaded from its route row, and stays where the route put it', async ({ page }) => {
  const { row, enqueued } = await routeSong(page);
  await row.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByText('Descargar', { exact: true }).click();
  await expect.poll(() => enqueued.flatMap((body) => body.items.map((item) => item.video_id))).toEqual([FOUND.id]);
  await expect(row).toBeVisible();
});
