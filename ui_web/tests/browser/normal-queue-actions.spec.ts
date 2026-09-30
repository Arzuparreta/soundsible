import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer, restoreQueueSession, TRACKS } from './music-browser-fixture';

const STREAMED = { id: 'normalSong1', youtube_id: 'normalSong1', title: 'Canción en streaming',
  artist: 'Artista externo', album: 'Disco externo', duration: 200, source: 'preview' as const };

test('NORMAL queue offers collection actions for the selected song without changing its occurrence', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({ json: {
    tracks: TRACKS, playlists: { Pruebas: [] }, settings: {}, podcast_subscriptions: [],
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
  const downloads: Array<{ items: Array<{ video_id: string }> }> = [];
  await page.route((url) => url.pathname === '/api/downloader/queue', async (route) => {
    if (route.request().method() === 'POST') {
      downloads.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'ok', ids: ['download-1'] } });
    } else await route.fulfill({ json: { queue: [], is_processing: false, logs: [] } });
  });
  await restoreQueueSession(page, { current: TRACKS[319], requests: [STREAMED] });
  await page.goto('/player/#/library?view=songs');
  await openMiniPlayer(page, /Canción de biblioteca 320/);
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(2).click();
  }
  const queue = page.locator('[data-now-playing-tile="queue"]');
  const row = queue.locator(`[data-drag-row="q-request-${STREAMED.id}"]`);
  const order = () => queue.locator('[data-drag-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-drag-row')));
  await expect(row).toBeVisible();
  const originalOrder = await order();
  await row.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByText('Añadir a playlist', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Compartir', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByText('Guardar en tu biblioteca', { exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].entry.keys).toContain(`yt:${STREAMED.id}`);
  await row.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByText('Añadir a favoritos', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByText('Añadir a favoritos', { exact: true }).click();
  await expect.poll(() => favourites.length).toBe(1);
  expect(favourites[0].favourite.keys).toContain(`yt:${STREAMED.id}`);
  await row.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByText('Añadir a playlist', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Pruebas/ }).click();
  await expect.poll(() => playlist).toEqual([{ track_id: STREAMED.id }]);
  await row.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByText('Descargar', { exact: true }).click();
  await expect.poll(() => downloads.flatMap((body) => body.items.map((item) => item.video_id))).toEqual([STREAMED.id]);
  expect(await order()).toEqual(originalOrder);

  // The current song also keeps its menu, despite having no play-row action.
  const current = queue.locator('[data-current]');
  await current.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByText('Añadir a playlist', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Editar datos', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Descargar', { exact: true })).toHaveCount(0);
});
