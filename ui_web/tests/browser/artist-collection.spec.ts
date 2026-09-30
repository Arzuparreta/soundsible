import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

const song = (id: number, title: string, album: string) => ({
  id: `deezer:track:${id}`, type: 'track', source: 'deezer', title, artist: 'Daft Punk', subtitle: 'Daft Punk',
  album, duration: 600, external_ids: { deezer_id: String(id) },
  raw: { deezer_id: String(id), track_number: 1, disc_number: 1 },
});

const DISCOGRAPHY = {
  artist: 'Daft Punk', deezer_id: '27', partial_failures: [], truncated: false,
  releases: [
    { deezer_id: '10', title: 'Discovery', record_type: 'album', year: 2001, track_ids: ['deezer:track:1', 'deezer:track:2'] },
    { deezer_id: '40', title: 'Alive EP', record_type: 'ep', year: 2003, track_ids: ['deezer:track:5'] },
  ],
  tracklist: [song(1, 'One More Time', 'Discovery'), song(2, 'Digital Love', 'Discovery'), song(5, 'Something About Us (Live)', 'Alive EP')],
};

test('an artist bookmark is independent of explicit bulk saving and downloading', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/artist?**', (route) => route.fulfill({ json: {
    name: 'Daft Punk', resolved: true, deezer_id: '27', top_tracks: [], albums: [], singles_eps: [],
    related_artists: [], candidates: [],
  } }));
  let discographyReads = 0;
  await page.route('**/api/catalog/artist/discography?**', (route) => {
    discographyReads++;
    return route.fulfill({ json: DISCOGRAPHY });
  });
  let bookmarked: unknown[] = [];
  await page.route((url) => url.pathname === '/api/library/saved-entities', async (route) => {
    if (route.request().method() === 'PUT') {
      const { entry, saved } = route.request().postDataJSON();
      bookmarked = saved ? [entry] : [];
    }
    await route.fulfill({ json: { entities: bookmarked } });
  });
  const savedSets: Array<{ entries: Array<{ keys: string[] }>; saved: boolean }> = [];
  await page.route((url) => url.pathname === '/api/library/saved/set', async (route) => {
    savedSets.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'success', changed: 3 } });
  });
  const downloads: unknown[] = [];
  await page.route((url) => url.pathname === '/api/catalog/artist/download', async (route) => {
    if (route.request().method() === 'POST') {
      downloads.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { job: {
        id: 'job-a', provider: 'artist:27', source_name: 'Daft Punk', state: 'queued', counts: { pending: 3 },
        selected_counts: { pending: 3 }, selected_track_count: 3, estimated_download_bytes: 0, selection: {},
        playlist_names: {}, manifest: { track_count: 3, library_count: 3, favourite_count: 0, playlists: [], warnings: [] }, tracks: [],
      } } });
      return;
    }
    await route.fulfill({ json: { job: null } });
  });

  await page.goto('/player/#/artist/Daft%20Punk?deezer_id=27&view=discover');

  // Photo and heading share the overflow tray for clicks and touch holds.
  for (const target of ['collection-header-cover', 'collection-header-name']) {
    const trigger = page.getByTestId(target);
    for (const button of ['left', 'right'] as const) {
      await trigger.click({ button });
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Guardar', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Añadir todas las canciones', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    const touch = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 180 };
    await trigger.dispatchEvent('pointerdown', touch);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-hold-gesture', '');
    await trigger.dispatchEvent('pointerup', touch);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.locator('html').getAttribute('data-hold-gesture')).toBeNull();
  }

  // A bookmark adds only the entity and can be removed without touching Songs.
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(bookmarked).toHaveLength(1);
  expect(savedSets).toHaveLength(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Guardado', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(bookmarked).toHaveLength(0);
  expect(savedSets).toHaveLength(0);

  expect(discographyReads).toBe(0);

  // Bulk saving is an explicit overflow action, independent of the bookmark.
  await page.getByRole('button', { name: 'Opciones', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Añadir todas las canciones', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/^3 canciones aparecerán/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Añadir todas las canciones', exact: true }).click();
  await expect.poll(() => savedSets.length).toBe(1);
  expect(savedSets[0].entries.map((entry) => entry.keys[0])).toEqual([
    'cat:deezer:track:1', 'cat:deezer:track:2', 'cat:deezer:track:5',
  ]);

  // Downloading all of it says how much, then hands it to the engine.
  // Removing a bookmark after bulk saving leaves every saved song alone.
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Guardado', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(savedSets).toHaveLength(1);
  expect(bookmarked).toHaveLength(0);
  await page.getByRole('button', { name: 'Opciones', exact: true }).click();
  await page.getByRole('button', { name: 'Descargar todo de Daft Punk', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/^3 canciones que aún no tienes descargadas, unos 41 MB/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Descargar', exact: true }).click();
  await expect.poll(() => downloads).toEqual([{ deezer_id: '27' }]);
  await expect(page.getByRole('button', { name: 'Descargando 0 de 3', exact: true })).toBeVisible();
});
