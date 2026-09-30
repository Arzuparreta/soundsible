import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

const song = (id: number, title: string) => ({
  id: `deezer:track:${id}`, type: 'track', source: 'deezer', title, artist: 'Daft Punk', subtitle: 'Daft Punk',
  album: 'Discovery', duration: 300, external_ids: { deezer_id: String(id) },
  raw: { deezer_id: String(id), deezer_album_id: '302127', track_number: id, disc_number: 1 },
});

const TRACKLIST = [song(1, 'One More Time'), song(2, 'Aerodynamic'), song(3, 'Digital Love')];

/** The engine's view of the album download: two songs in, one it is unsure of. */
const reviewJob = {
  id: 'job-1', provider: 'album:302127', source_name: 'Discovery', state: 'needs_review',
  counts: { completed: 2, needs_review: 1 }, selected_counts: { completed: 2, needs_review: 1 },
  selected_track_count: 3, estimated_download_bytes: 0, selection: {}, playlist_names: {},
  manifest: { track_count: 3, library_count: 3, favourite_count: 0, playlists: [], warnings: [] },
  tracks: [
    { source_key: 'album:302127:deezer:1', source: { title: 'One More Time', artist: 'Daft Punk', album: 'Discovery' }, state: 'completed', confidence: 1, candidates: [] },
    { source_key: 'album:302127:deezer:2', source: { title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery' }, state: 'completed', confidence: 1, candidates: [] },
    {
      source_key: 'album:302127:deezer:3', source: { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery' },
      state: 'needs_review', confidence: 0.6,
      candidates: [{ kind: 'catalog', video_id: 'abcdefghijk', title: 'Digital Love (Official Audio)', artist: 'Daft Punk', duration: 301, confidence: 0.6 }],
    },
  ],
};

test('an album is saved with its songs, downloaded in one go, and a doubtful song is settled from its page', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/album?**', (route) => route.fulfill({ json: {
    title: 'Discovery', artist: 'Daft Punk', cover: '', year: 2001, genre: '', resolved: true, deezer_id: '302127',
    in_library: false, cached: false, partial_failures: [], tracklist: TRACKLIST,
  } }));
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
  await page.route((url) => url.pathname === '/api/catalog/album/download', async (route) => {
    if (route.request().method() === 'POST') {
      downloads.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { job: reviewJob } });
      return;
    }
    await route.fulfill({ json: { job: null } });
  });
  const decisions: unknown[] = [];
  await page.route((url) => url.pathname.startsWith('/api/migration/jobs/job-1/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    decisions.push({ path, body: route.request().postDataJSON() });
    // A decision leaves the stopped job as it was; resuming it queues it.
    const state = path.endsWith('/decision') ? 'needs_review' : 'queued';
    await route.fulfill({ json: { job: { ...reviewJob, state, selected_counts: { completed: 2, pending: 1 } } } });
  });

  await page.goto('/player/#/album/Discovery?artist=Daft+Punk&view=discover&deezer_id=302127');

  // One save: the record, and every song on it.
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => savedSets.length).toBe(1);
  expect(savedSets[0].saved).toBe(true);
  expect(savedSets[0].entries.map((entry) => entry.keys[0])).toEqual([
    'cat:deezer:track:1', 'cat:deezer:track:2', 'cat:deezer:track:3',
  ]);

  // Then the next step, for all of them at once.
  await page.getByRole('button', { name: 'Descargar el álbum', exact: true }).click();
  await expect.poll(() => downloads).toEqual([{ deezer_id: '302127' }]);

  // The engine was unsure of one: the album says so and lets you choose.
  await page.getByRole('button', { name: 'Revisar 1', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Elige la versión', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: /Digital Love \(Official Audio\)/ }).click();

  await expect.poll(() => decisions.length).toBe(2);
  expect(decisions[0]).toEqual({
    path: '/api/migration/jobs/job-1/decision',
    body: expect.objectContaining({ source_key: 'album:302127:deezer:3', decision: 'use_candidate', candidate: expect.objectContaining({ video_id: 'abcdefghijk' }) }),
  });
  expect(decisions[1]).toEqual({ path: '/api/migration/jobs/job-1/control', body: { action: 'resume' } });
});
