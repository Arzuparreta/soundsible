import { expect, test, type Locator, type Page } from '@playwright/test';
import { openMiniPlayer, silentStream } from './music-browser-fixture';
import { snapCarousel } from './playerGestures';

/* A library long enough for the queue's context lane to scroll: the bug only
   shows once the panel under the finger has something to scroll. */
const tracks = Array.from({ length: 80 }, (_, index) => ({
  id: `swipe-${index}`,
  title: `Canción ${index}`,
  artist: 'Artista de prueba',
  album: 'Un álbum',
  duration: 180,
}));

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = { requires_login: true, user: { id: 'qa', username: 'qa', display_name: 'QA', role: 'admin', has_password: true } };
    }
    if (path === '/api/library') body = { tracks, playlists: {}, settings: {}, podcast_subscriptions: [] };
    if (path === '/api/library/favourites') body = [];
    if (path === '/api/downloader/queue') body = { queue: [], is_processing: false, logs: [] };
    if (path === '/api/downloader/config') body = { quality: 'high', auto_update_ytdlp: false };
    if (path === '/api/discovery/settings') body = { learning_enabled: true, autoplay_enabled: false };
    if (path === '/api/discovery/music/feed') body = { sections: [] };
    if (['/api/devices', '/api/paired-devices', '/api/pairing/sessions'].includes(path)) body = { devices: [], sessions: [] };
    await route.fulfill({ json: body });
  });
  await silentStream(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

/** A real touch drag, dispatched through the browser's own input pipeline:
    scroll chaining is decided by the compositor, and synthesised DOM touch
    events never reach it. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  delta: { dx?: number; dy?: number },
  steps = 12,
) {
  const dx = delta.dx ?? 0;
  const dy = delta.dy ?? 0;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let step = 1; step <= steps; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

/**
 * A box worth dragging from: the element has stopped moving, and the point the
 * drag will touch is on screen.
 *
 * Snapping the carousel settles it sideways, but the surface around it is still
 * entering. Measured inside that entrance the lane reports y=905 in an 844px
 * viewport — below the fold — so `elementFromPoint` at the drag coordinates
 * returns null, the touch lands on nothing, and "scrollTop stayed 0" reads as
 * exactly the scroll-chaining regression this test exists to catch. It failed
 * on the first attempt every time and passed on the retry, where the browser
 * was warm enough to have finished the entrance first.
 *
 * `settle()` is not enough here: it gives up after 2s and skips the looping
 * animations the surface keeps running. Waiting on the geometry itself is what
 * the drag actually depends on.
 */
async function settledBox(page: Page, target: Locator, offsetY: number) {
  let previous: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const viewport = page.viewportSize()!;
    const still = !!box && !!previous && box.x === previous.x && box.y === previous.y;
    previous = box && { x: box.x, y: box.y };
    return !!box && still && box.y + offsetY < viewport.height;
  }, { message: 'the drag point must stop moving and be on screen' }).toBe(true);
  return (await target.boundingBox())!;
}

test.beforeEach(async ({ page }) => { await mockEngine(page); });

test('a scrolled player panel still hands a sideways swipe to the pager', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || (page.viewportSize()?.width ?? 1024) > 1023, 'real Chromium touch input');
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción 79/ }).click();
  await openMiniPlayer(page, /Canción 79/);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();

  const stage = page.locator('[data-now-playing-tile="stage"]');
  const queue = page.locator('[data-now-playing-tile="queue"]');
  const browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(stage).not.toHaveAttribute('inert', '');

  // The queue, scrolled, is the panel the swipe used to die on.
  await snapCarousel(page, 'queue');
  await expect(queue).not.toHaveAttribute('inert', '');
  const lane = queue.locator('[data-section-rows]').last();
  const laneBox = await settledBox(page, lane, 120);
  await touchDrag(page, { x: laneBox.x + laneBox.width / 2, y: laneBox.y + 120 }, { dy: -120 }, 10);
  await expect.poll(() => lane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await touchDrag(page, { x: laneBox.x + 40, y: laneBox.y + 120 }, { dx: 240 });
  await expect(stage).not.toHaveAttribute('inert', '');
  await expect(queue).toHaveAttribute('inert', '');

  // And the same from the browser, whose body scrolls as one piece.
  await snapCarousel(page, 'browser');
  await expect(browser).not.toHaveAttribute('inert', '');
  const body = browser.locator('[data-browser-body]').first();
  const bodyBox = (await body.boundingBox())!;
  const bodyPoint = { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + Math.min(bodyBox.height / 2, 150) };
  await touchDrag(page, bodyPoint, { dy: -120 }, 10);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await touchDrag(page, bodyPoint, { dx: -240 });
  await expect(stage).not.toHaveAttribute('inert', '');
  await expect(browser).toHaveAttribute('inert', '');
});
