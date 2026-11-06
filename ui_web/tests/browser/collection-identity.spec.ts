import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('a playlist keeps its musical items as audio moves between stream and file', async ({ page }) => {
  await mockMusicEngine(page);
  const paper = { id: 'paper-file', item_id: 'paper-item', title: 'Papel secante', artist: 'Extremoduro', duration: 296 };
  const preview = { id: '7N3rFdE3u3Y', item_id: 'autorretrato-item', title: 'Autorretrato', artist: 'Extremoduro', source: 'preview' };
  let downloaded = false;
  const song = () => downloaded
    ? { ...preview, id: 'download-file', source: undefined, youtube_id: preview.id }
    : preview;
  const playlists = { 'best of hardextreme': [paper.item_id, preview.item_id] };
  await page.route(url => url.pathname === '/api/library', route => route.fulfill({
    headers: { 'X-Soundsible-Collection': 'true' },
    json: { tracks: downloaded ? [paper, song()] : [paper], playlists, settings: {}, podcast_subscriptions: [] },
  }));
  await page.route(url => url.pathname === '/api/library/collection', route => route.fulfill({ json: {
    items: [paper, song()], files: downloaded ? [paper, song()] : [paper], playlists, saved: [], revision: downloaded ? 2 : 1,
    library_revision: Number(downloaded), settings: {}, podcast_subscriptions: [],
  } }));
  await page.goto('/player/#/playlists/best%20of%20hardextreme');
  await expect(page.getByText('Autorretrato', { exact: true })).toBeVisible();
  await expect(page.getByText('Papel secante', { exact: true })).toBeVisible();
  downloaded = true;
  await page.evaluate(async () => {
    const modulePath = '/player/src/stores/index.ts';
    const { actions } = await import(/* @vite-ignore */ modulePath);
    await actions.syncLibrary();
  });
  await expect(page.getByText('Autorretrato', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/player/src/stores/index.ts';
    const { musicLibrary, state } = await import(/* @vite-ignore */ modulePath);
    return { source: musicLibrary().find(row => row.item_id === 'autorretrato-item')?.id,
      playlist: [...state.playlists['best of hardextreme']] };
  })).toEqual({ source: 'download-file', playlist: [paper.item_id, preview.item_id] });
  downloaded = false;
  await page.reload();
  await expect(page.getByText('Autorretrato', { exact: true })).toBeVisible();
  await expect(page.getByText('Papel secante', { exact: true })).toBeVisible();
});

test('adding a DJ preview claims its musical item with one request', async ({ page }) => {
  await mockMusicEngine(page);
  const song = { id: '7N3rFdE3u3Y', title: 'Autorretrato', artist: 'Extremoduro', source: 'preview' };
  const requests: unknown[] = [];
  let added = false;
  const snapshot = () => ({ items: added ? [{ ...song, item_id: 'stable-item' }] : [],
    saved: added ? [{ item_id: 'stable-item', keys: [`yt:${song.id}`], title: song.title }] : [],
    playlists: { Mix: added ? ['stable-item'] : [] }, files: [], settings: {}, podcast_subscriptions: [], library_revision: Number(added), revision: Number(added) });
  await page.route(url => url.pathname === '/api/library', route => route.fulfill({
    headers: { 'X-Soundsible-Collection': 'true' },
    json: { tracks: [], playlists: { Mix: [] }, settings: {}, podcast_subscriptions: [] },
  }));
  await page.route(url => url.pathname === '/api/library/collection', route => route.fulfill({ json: snapshot() }));
  await page.route('**/api/library/playlists/Mix/tracks', route => {
    requests.push(route.request().postDataJSON()); added = true;
    return route.fulfill({ json: { status: 'success', ...snapshot(), settings: {} } });
  });
  const secondarySaves: string[] = [];
  await page.route('**/api/library/saved/toggle', route => {
    secondarySaves.push(route.request().url()); return route.fulfill({ json: {} });
  });
  await page.goto('/player/#/playlists/Mix');
  await expect.poll(() => page.evaluate(async () => {
    const modulePath = '/player/src/stores/index.ts';
    return (await import(/* @vite-ignore */ modulePath)).state.collectionItems;
  })).toEqual([]);
  await page.evaluate(async track => {
    const modulePath = '/player/src/stores/index.ts';
    await (await import(/* @vite-ignore */ modulePath)).actions.addToPlaylist('Mix', track);
  }, song);
  await expect(page.getByText('Autorretrato', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ entry: { keys: [`yt:${song.id}`], title: song.title } });
  expect(secondarySaves).toEqual([]);
});
