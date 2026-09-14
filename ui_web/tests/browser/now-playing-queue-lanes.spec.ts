import { expect, test, type Page } from '@playwright/test';
import { settle } from './settle';
import { snapPlayerCarousel } from './playerGestures';

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
  // The panel settled before the lanes existed. They arrive with an entrance of
  // their own, and a rect read inside it is a rect of something still growing.
  await settle(page, '[data-now-playing-tile="queue"]');

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
  const laneRows = queue.locator('[data-section-rows]');
  await expect.poll(() => laneRows.count()).toBeGreaterThan(1);
  // Polled rather than read once: a lane that has not finished laying out
  // measures zero, which looks exactly like the collapse this guards against.
  await expect
    .poll(async () => {
      const heights = await laneRows.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().height),
      );
      return Math.min(...heights);
    }, { message: 'every lane must show songs, not only its label' })
    .toBeGreaterThan(40);
});

test('the context lane names where it came from', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  const queue = await openQueuePanel(page);

  // `text-transform: uppercase` is CSS only, so the DOM keeps the real casing.
  await expect(queue.getByText('De Tu biblioteca', { exact: true })).toBeVisible();
});

/**
 * On a phone the queue is one card of the pager, and its lanes each scroll
 * themselves — so unlike the browser panel beside it, nothing about the
 * bottom of the list is scrolled through. Whatever sits below the last lane
 * is permanent: the footer clearance the pager pill floats in, and, until
 * this was fixed, a lane gap on top of it. The list stopped short of the
 * card and left a strip of empty panel the search tab never showed.
 */
test('the queue ends on the same line the browser list does', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'mobile-only regression');
  await openQueuePanel(page);
  await snapPlayerCarousel(page, 'now-playing', 'queue');
  await settle(page, '[data-now-playing-tile="queue"]');

  const lanes = page.locator('[data-now-playing-tile="queue"] [data-section-rows]');
  await expect.poll(() => lanes.count()).toBeGreaterThan(0);
  // A lane scrolls itself only once it has been squeezed, which is the state
  // this measures: a short queue leaves room below it for honest reasons.
  await expect
    .poll(async () => {
      const room = await lanes.evaluateAll((nodes) =>
        nodes.map((node) => node.scrollHeight - node.clientHeight),
      );
      return Math.max(...room);
    }, { message: 'the queue must be long enough to scroll' })
    .toBeGreaterThan(0);

  const queueEnd = await lanes.last().evaluate((lane) => {
    const rows = lane.closest('section')!.parentElement!;
    const style = getComputedStyle(rows);
    return {
      lane: lane.getBoundingClientRect().bottom,
      // Where the list box itself stops, clearance excluded. The lanes have to
      // reach it; anything left over is the gap this test exists for.
      content: rows.getBoundingClientRect().bottom - parseFloat(style.paddingBottom),
    };
  });
  expect(Math.abs(queueEnd.lane - queueEnd.content)).toBeLessThanOrEqual(1);

  await snapPlayerCarousel(page, 'now-playing', 'browser');
  await settle(page, '[data-now-playing-tile="browser"]');
  const browserEnd = await page
    .locator('[data-now-playing-tile="browser"] [data-browser-body]')
    .first()
    .evaluate((body) =>
      body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(body).paddingBottom),
    );

  // Both cards are the same size and both reserve the same clearance, so the
  // last song of either list belongs on the same line.
  expect(Math.abs(queueEnd.lane - browserEnd)).toBeLessThanOrEqual(1);

  // And that line is the clearance: the pill keeps its own air above it.
  const pill = (await page.locator('nav[aria-label="Paneles de NORMAL"]').boundingBox())!;
  expect(pill.y - queueEnd.lane).toBeGreaterThan(0);
  expect(pill.y - queueEnd.lane).toBeLessThanOrEqual(24);
});
