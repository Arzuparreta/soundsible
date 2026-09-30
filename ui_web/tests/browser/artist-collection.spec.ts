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

test('an artist is saved with every song they released, and downloaded whole after saying how much', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/artist?**', (route) => route.fulfill({ json: {
    name: 'Daft Punk', resolved: true, deezer_id: '27', top_tracks: [], albums: [], singles_eps: [],
    related_artists: [], candidates: [],
  } }));
  await page.route('**/api/catalog/artist/discography?**', (route) => route.fulfill({ json: DISCOGRAPHY }));
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

  // Saving an artist says how many songs will arrive, and nothing does on "no".
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('Guardar a Daft Punk', { exact: true })).toBeVisible();
  await expect(confirm.getByText(/^3 canciones de sus álbumes, singles y EPs/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => savedSets.length).toBe(1);
  expect(savedSets[0].entries.map((entry) => entry.keys[0])).toEqual([
    'cat:deezer:track:1', 'cat:deezer:track:2', 'cat:deezer:track:5',
  ]);

  // Downloading all of it says how much, then hands it to the engine.
  await page.getByRole('button', { name: 'Descargar todo de Daft Punk', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/^3 canciones que aún no tienes descargadas, unos 41 MB/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Descargar', exact: true }).click();
  await expect.poll(() => downloads).toEqual([{ deezer_id: '27' }]);
  await expect(page.getByRole('button', { name: 'Descargando 0 de 3', exact: true })).toBeVisible();
});
