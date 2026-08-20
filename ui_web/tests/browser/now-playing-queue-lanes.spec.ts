import { expect, test, type Page } from '@playwright/test';
import { settle } from './settle';

/**
 * Playing one song out of a large library is what exposed this: the context
 * lane holds the whole library, its flex base dominates the shrink, and the
 * one-row "Sonando ahora" lane above it was squeezed to a few pixels. Its
 * label cannot shrink below 26px, so it spilled out of its own lane and landed
 * on top of the next lane's label. The library has to be big for the ratio to
 * bite.
 */
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
        user: { id: 'queue-qa', username: 'queue-qa', display_name: 'Queue QA', role: 'admin', has_password: true },
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

/**
 * Play the song at the top of the library — the list reads newest first, so
 * that is track 320 — which leaves the other 319 in the context lane.
 */
async function openQueuePanel(page: Page) {
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await page.getByRole('button', { name: /Canción de biblioteca 320/ }).last().click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  const queue = page.locator('[data-now-playing-tile="queue"]');
  await expect(queue).toBeVisible();
  await settle(page, '[data-now-playing-tile="queue"]');
  return queue;
}

test.beforeEach(async ({ page }) => {
  await mockEngine(page);
});

test('queue lane labels never land on top of each other', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  const queue = await openQueuePanel(page);

  const heads = queue.locator('section[data-head] > div:first-child');
  await expect.poll(() => heads.count()).toBeGreaterThan(1);

  const boxes = await heads.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, text: node.textContent ?? '' };
    }),
  );

  for (let i = 1; i < boxes.length; i += 1) {
    const above = boxes[i - 1];
    const below = boxes[i];
    expect(
      above.bottom,
      `"${above.text}" overlaps "${below.text}"`,
    ).toBeLessThanOrEqual(below.top);
  }

  // A lane squeezed past its label is a lane showing none of its songs, which
  // is the same collapse seen from the other side.
  const laneHeights = await queue
    .locator('[data-section-rows]')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(laneHeights.length).toBeGreaterThan(1);
  for (const height of laneHeights) expect(height).toBeGreaterThan(40);
});

test('the context lane names where it came from', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  const queue = await openQueuePanel(page);

  // `text-transform: uppercase` is CSS only, so the DOM keeps the real casing.
  await expect(queue.getByText('De Tu biblioteca', { exact: true })).toBeVisible();
});
