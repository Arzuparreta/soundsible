import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('opening a discovered album repairs its known orphan and plays owned audio', async ({ page }) => {
  await mockMusicEngine(page);
  let repairs = 0;
  const streams: string[] = [];
  const track = { id: 'owned-contra', title: 'Contra Todos', artist: 'Robe', album: '', duration: 420 };
  const item = {
    id: 'deezer:track:3240262871', type: 'track', source: 'deezer', title: track.title,
    artist: track.artist, album: 'Lo Que Aletea en Nuestras Cabezas', duration: 427,
    track_id: track.id, action_state: { in_library: true, playable: true, downloadable: false, needs_resolution: false },
    raw: { track_number: 8, disc_number: 1, year: 2015, album_artist: 'Robe' },
  };
  const profile = {
    title: item.album, artist: 'Robe', cover: '', tracklist: [item], deezer_id: '715226121',
    in_library: true, resolved: true, cached: false, reconciliation_needed: true,
  };
  await page.route(url => url.pathname === '/api/library', route => route.fulfill({ json: {
    tracks: [track], playlists: {}, settings: {}, podcast_subscriptions: [],
  } }));
  await page.route('**/api/catalog/album?**', route => route.fulfill({ json: profile }));
  await page.route('**/api/catalog/album/reconcile', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ deezer_id: '715226121' });
    repairs++;
    await route.fulfill({ json: { ...profile, reconciliation_needed: false } });
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/static/stream/')) streams.push(request.url());
  });
  await page.route('**/api/catalog/resolve', () => { throw new Error('Owned audio must not be resolved again'); });
  await page.goto(`/player/#/album/${encodeURIComponent(item.album)}?artist=Robe&view=discover&deezer_id=715226121`);
  await expect.poll(() => repairs).toBe(1);
  await expect(page.getByText('Contra Todos', { exact: true }).first()).toBeVisible();
  await page.getByText('Contra Todos', { exact: true }).first().click();
  await expect.poll(() => streams.some(url => url.includes('/api/static/stream/owned-contra'))).toBe(true);
});
