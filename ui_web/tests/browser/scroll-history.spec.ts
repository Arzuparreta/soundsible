import { expect, test, type Page } from '@playwright/test';

const catalogTrack = (index: number) => ({
  id: `deezer:track:${index}`,
  type: 'track',
  source: 'deezer',
  title: `Track ${index}`,
  subtitle: 'Scroll Artist',
  artist: 'Scroll Artist',
  album: 'Album 1',
  duration: 180,
  cover: '',
  popularity: 100 - index,
  track_id: null,
  external_ids: {},
  attribution_url: '',
  action_state: {
    in_library: false,
    playable: false,
    downloadable: true,
    needs_resolution: true,
  },
  raw: {},
});

async function mockEngine(page: Page) {
  let artistRequests = 0;
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: {
          id: 'scroll-user',
          username: 'scroll',
          display_name: 'Scroll QA',
          role: 'admin',
          has_password: true,
        },
      };
    } else if (path === '/api/library') {
      body = { tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: true };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/devices' || path === '/api/paired-devices') {
      body = { devices: [] };
    } else if (path === '/api/pairing/sessions') {
      body = { sessions: [] };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [], items: [] };
    } else if (path === '/api/catalog/artist') {
      artistRequests += 1;
      // The return traversal must wait for real asynchronous content rather
      // than accidentally restoring against the initial skeleton.
      if (artistRequests > 1) await new Promise((resolve) => setTimeout(resolve, 100));
      body = {
        name: 'Scroll Artist',
        resolved: true,
        deezer_id: 'artist-1',
        metadata: { name: 'Scroll Artist', picture: '', nb_fans: 1000 },
        candidates: [],
        top_tracks: Array.from({ length: 10 }, (_, index) => catalogTrack(index + 1)),
        albums: [
          { deezer_id: 'album-1', title: 'Album 1', cover: '', year: 2026, track_count: 8 },
          { deezer_id: 'album-2', title: 'Album 2', cover: '', year: 2025, track_count: 7 },
        ],
        singles_eps: [],
        related_artists: [],
        in_library: false,
        partial_failures: [],
        cached: false,
      };
    } else if (path === '/api/catalog/album') {
      body = {
        title: 'Album 1',
        artist: 'Scroll Artist',
        cover: '',
        year: 2026,
        tracklist: Array.from({ length: 8 }, (_, index) => catalogTrack(index + 1)),
        in_library: false,
        resolved: true,
        partial_failures: [],
        cached: false,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test('back restores an async artist surface without retrying layout', async ({ page }) => {
  await mockEngine(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'en');
  });
  await page.goto('/player/#/artist/Scroll%20Artist?view=discover&deezer_id=artist-1');
  await expect(page.getByRole('heading', { name: 'Scroll Artist', level: 1 })).toBeVisible();

  const album = page.getByRole('button', { name: /Album 1/ });
  await album.scrollIntoViewIfNeeded();
  const expectedTop = await page.locator('[data-primary-scroll]').evaluate((element) => element.scrollTop);
  expect(expectedTop).toBeGreaterThan(100);

  await album.click();
  await expect(page.getByRole('heading', { name: 'Album 1', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Scroll Artist', level: 1 })).toBeVisible();

  await expect.poll(
    () => page.locator('[data-primary-scroll]').evaluate((element) => element.scrollTop),
  ).toBe(expectedTop);
});
