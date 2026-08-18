import { expect, test, type Page } from '@playwright/test';

const catalogTrack = (index: number) => ({
  id: `local:${index}`,
  title: `Track ${index}`,
  artist: 'Header Scroll Artist',
  album: 'Album 1',
  duration: 180,
  cover: '',
  path: `/music/track-${index}.mp3`,
  favourite: false,
  downloaded: true,
  added_at: '2026-01-01T00:00:00Z',
});

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
      body = {
        tracks: Array.from({ length: 80 }, (_, index) => catalogTrack(index + 1)),
        playlists: {},
        settings: {},
        podcast_subscriptions: [],
      };
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
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

test('tapping the library header returns a scrolled track list to the top', async ({ page }) => {
  await mockEngine(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'en');
  });
  await page.goto('/player/#/');

  const heading = page.getByRole('button', { name: 'Your library' });
  await expect(heading).toBeVisible();
  await expect(page.getByText('Track 80')).toBeVisible();

  const surface = page.locator('[data-primary-scroll]');
  await surface.evaluate((element) => {
    element.scrollTo({ top: 600 });
  });
  await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);

  await heading.click();

  await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBe(0);
});
