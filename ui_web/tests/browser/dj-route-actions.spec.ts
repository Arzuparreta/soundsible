import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

/** A song the DJ found outside the library: in the route, not yet kept. */
const FOUND = { id: 'routeSong01', youtube_id: 'routeSong01', title: 'Canción encontrada', artist: 'Artista externo', duration: 200 };

test('a song the DJ found is downloaded from its route row, and stays where the route put it', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/discovery/music/dj-plan', (route) => route.fulfill({ json: {
    items: [
      { ...FOUND, source_pool: 'related', recommendation_identity: `music:yt:${FOUND.id}` },
      ...TRACKS.slice(0, 4).map((row) => ({ ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}` })),
    ],
    requests: [], pool_counts: {},
  } }));
  const enqueued: Array<{ items: Array<{ video_id?: string }> }> = [];
  await page.route((url) => url.pathname === '/api/downloader/queue', async (route) => {
    if (route.request().method() === 'POST') {
      enqueued.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'ok', ids: ['download-1'] } });
      return;
    }
    await route.fulfill({ json: { queue: [], is_processing: false, logs: [] } });
  });

  await openMusicPlayer(page);
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(2).click();
  const route = page.locator('[data-auto-tile="route"]');
  const row = route.locator('[data-drag-row]').filter({ hasText: FOUND.title });
  await expect(row).toBeVisible();

  // The panel draws no ⋯: a phone holds the row (or asks with the menu key),
  // a pointer right-clicks it.
  if (mobile) {
    await row.locator('[data-row-main]').focus();
    await page.keyboard.press('Shift+F10');
  } else {
    await row.click({ button: 'right' });
  }
  const menu = page.getByRole('dialog');
  await expect(menu.getByText('Guardar en tu biblioteca', { exact: true })).toBeVisible();
  await expect(menu.getByText('Añadir a playlist', { exact: true })).toBeVisible();
  // Deleting and placing belong to the route, not to the song.
  await expect(menu.getByText('Eliminar de la biblioteca', { exact: true })).toHaveCount(0);
  await expect(menu.getByText('Reproducir ahora', { exact: true })).toHaveCount(0);
  await menu.getByText('Descargar', { exact: true }).click();

  await expect.poll(() => enqueued.flatMap((body) => body.items.map((item) => item.video_id))).toEqual([FOUND.id]);
  await expect(row).toBeVisible();
});
