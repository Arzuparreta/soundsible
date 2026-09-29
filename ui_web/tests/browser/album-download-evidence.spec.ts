import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

const song = (id: number, title: string, position: number) => ({
  id: `deezer:track:${id}`, type: 'track', source: 'deezer', title, artist: 'Daft Punk', subtitle: 'Daft Punk',
  album: 'Discovery', duration: 300, external_ids: { deezer_id: String(id) },
  raw: { deezer_id: String(id), deezer_album_id: '302127', track_number: position, disc_number: 1 },
});

test('a song downloaded from an album page is filed on that album, in its place', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/album?**', (route) => route.fulfill({ json: {
    title: 'Discovery', artist: 'Daft Punk', cover: '', year: 2001, genre: '', resolved: true, in_library: false,
    cached: false, partial_failures: [],
    tracklist: [song(1, 'One More Time', 1), song(2, 'Aerodynamic', 2), song(3, 'Digital Love', 3)],
  } }));
  const saves: Array<Record<string, unknown>> = [];
  await page.route((url) => url.pathname === '/api/catalog/save', async (route) => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'queued', queue_id: 'q-1', video_id: 'abcdefghijk' } });
  });

  await page.goto('/player/#/album/Discovery?artist=Daft+Punk&view=discover&deezer_id=302127');
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (mobile) {
    const row = page.locator('[data-music-list-row]').filter({ hasText: 'Digital Love' });
    await row.locator('[data-row-menu]').click();
    await page.getByRole('dialog').getByText('Descargar', { exact: true }).click();
  } else {
    // ＋ claims the song, then ⬇ gives it a file.
    const row = page.locator('[data-pressable]').filter({ hasText: 'Digital Love' });
    await row.getByRole('button', { name: 'Guardar en tu biblioteca', exact: true }).click();
    await row.getByRole('button', { name: 'Descargar', exact: true }).click();
  }

  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    title: 'Digital Love', artist: 'Daft Punk',
    album: 'Discovery', album_artist: 'Daft Punk', track_number: 3, disc_number: 1, year: 2001,
  });
});
