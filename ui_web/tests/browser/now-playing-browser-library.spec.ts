import { expect, test, type Page } from '@playwright/test';

const TRACKS = Array.from({ length: 320 }, (_, index) => ({
  id: `library-track-${index + 1}`,
  title: `Canción de biblioteca ${index + 1}`,
  artist: `Artista ${index % 24}`,
  album: 'Biblioteca de prueba',
  duration: 180,
}));

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: { id: 'library-qa', username: 'library-qa', display_name: 'Library QA', role: 'admin', has_password: true },
      };
    } else if (path === '/api/library') {
      body = { tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    } else if (path === '/api/devices' || path === '/api/paired-devices' || path === '/api/pairing/sessions') {
      body = { devices: [], sessions: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

async function openNowPlaying(page: Page) {
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 1/ }).click();
  await page.getByRole('button', { name: /Canción de biblioteca 1/ }).last().click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockEngine(page);
});

test('desktop Now Playing opens Library directly on visible virtual song rows', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  await openNowPlaying(page);

  const browser = page.locator('[data-now-playing-tile="browser"]');
  await browser.getByRole('button', { name: /^Biblioteca/ }).click();

  await expect(browser.getByText('Canción de biblioteca 1', { exact: true })).toBeVisible();
  await expect.poll(() => browser.locator('[data-virtual-rows] > div').count()).toBeGreaterThan(0);
});
