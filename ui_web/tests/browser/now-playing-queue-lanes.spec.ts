import { expect, test, type Page } from '@playwright/test';
import { openMiniPlayer, silentStream } from './music-browser-fixture';
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
  await silentStream(page);
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
  await openMiniPlayer(page, /Canción de biblioteca 320/);
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
 * On a phone the queue is one card of the pager, and the box holding its lanes
 * fills with them and then almost never scrolls — so unlike the browser panel
 * beside it, whose body always overflows, a bottom padding there is not a band
 * the list is scrolled past. It is permanent empty panel, and reserving the
 * pager pill's clearance that way held the queue a whole clearance short of
 * the card's edge: the search tab painted its rows down to the bottom, the
 * queue stopped above it and showed the difference as a dead strip.
 *
 * Two things have to hold at once, and it is the pair that pins the fix: the
 * lanes reach the bottom of the card, *and* the last song still comes to rest
 * above the pill rather than under it. Either one alone is satisfied by the
 * bug — the old padding bought the second by giving up the first.
 */
test('the queue fills its card the way the browser does, and still clears the pill', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'mobile-only regression');
  await openQueuePanel(page);
  await snapPlayerCarousel(page, 'now-playing', 'queue');
  await settle(page, '[data-now-playing-tile="queue"]');

  const queue = page.locator('[data-now-playing-tile="queue"]');
  const lanes = queue.locator('[data-section-rows]');
  await expect.poll(() => lanes.count()).toBeGreaterThan(0);
  // A lane scrolls itself only once it has been squeezed, which is the state
  // this measures: a short queue leaves room below it for honest reasons.
  await expect
    .poll(() => lanes.last().evaluate((lane) => lane.scrollHeight - lane.clientHeight),
      { message: 'the queue must be long enough to scroll' })
    .toBeGreaterThan(0);

  // How far the painted list stops short of the card it sits in. For the queue
  // that is the bottom lane's own box; for the browser it is the body's
  // padding edge, which is where its overflowing rows are clipped. Both are
  // polled rather than read once: a panel measured while it is still coming in
  // is a panel still growing, and the shortfall of one is the whole assertion.
  await expect
    .poll(() => queue.evaluate((tile) => {
      const laneNodes = [...tile.querySelectorAll('[data-section-rows]')];
      const last = laneNodes[laneNodes.length - 1] as HTMLElement;
      return tile.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    }), { message: 'the queue left a strip of empty panel under its bottom lane' })
    .toBeLessThanOrEqual(1);

  await snapPlayerCarousel(page, 'now-playing', 'browser');
  await settle(page, '[data-now-playing-tile="browser"]');
  // The same line, measured the same way on the panel that always reached it.
  await expect
    .poll(() => page.locator('[data-now-playing-tile="browser"]').evaluate((tile) => {
      const body = tile.querySelector('[data-browser-body]') as HTMLElement;
      return tile.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
    }), { message: 'the browser panel no longer reaches the bottom of its card' })
    .toBeLessThanOrEqual(1);

  // And the clearance is still doing its job, one scrollport further in: at the
  // end of the bottom lane the last song rests above the pill, not beneath it.
  await snapPlayerCarousel(page, 'now-playing', 'queue');
  await settle(page, '[data-now-playing-tile="queue"]');

  // Row and pill are read in the same frame, and the lane is only measured
  // once it reports itself at its end. It is virtualized, so the frame after a
  // scroll still holds the rows of the range it left — and the pill, read back
  // on its own after a trip across the pager, can be caught still travelling.
  const airAbovePill = async () => {
    await lanes.last().evaluate((lane) => { lane.scrollTop = lane.scrollHeight; });
    return page.evaluate(() => {
      const all = [...document.querySelectorAll('[data-now-playing-tile="queue"] [data-section-rows]')];
      const lane = all[all.length - 1] as HTMLElement | undefined;
      const pill = document.querySelector('nav[aria-label="Paneles de NORMAL"]');
      if (!lane || !pill) return null;
      if (Math.abs(lane.scrollTop + lane.clientHeight - lane.scrollHeight) > 1) return null;
      const rows = [...lane.querySelectorAll('[data-drag-row]')] as HTMLElement[];
      if (!rows.length) return null;
      const bottom = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
      return Math.round(pill.getBoundingClientRect().top - bottom);
    });
  };

  const rests = 'the last song rests just above the pager pill';
  await expect
    .poll(async () => {
      const air = await airAbovePill();
      if (air === null) return 'the bottom lane has not settled at its end';
      if (air < 0) return `the last song sits ${-air}px under the pager pill`;
      // The band the bug left behind arrives from the other side: air wide
      // enough to read as empty panel is as wrong as no air at all.
      if (air > 24) return `${air}px of empty panel stands above the pager pill`;
      return rests;
    }, { message: 'the bottom lane must end on the pill, with its clearance and no more' })
    .toBe(rests);
});
