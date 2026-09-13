import { expect, test, type Page } from '@playwright/test';
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
  /* Real audio behind the stream URL: a failed load skips to the next track,
     and the song the mini-player names would then be a race. */
  const samples = 8000 * 180;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await page.route('**/api/static/stream/**', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
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

test.beforeEach(async ({ page }) => { await mockEngine(page); });

test('a scrolled player panel still hands a sideways swipe to the pager', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium' || (page.viewportSize()?.width ?? 1024) > 1023, 'real Chromium touch input');
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción 79/ }).click();
  const miniPlayer = page.locator('[data-omni-player]');
  await expect(miniPlayer).toBeVisible();
  await miniPlayer.getByRole('button', { name: /Canción 79/ }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();

  const stage = page.locator('[data-now-playing-tile="stage"]');
  const queue = page.locator('[data-now-playing-tile="queue"]');
  const browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(stage).not.toHaveAttribute('inert', '');

  // The queue, scrolled, is the panel the swipe used to die on.
  await snapCarousel(page, 'queue');
  await expect(queue).not.toHaveAttribute('inert', '');
  const lane = queue.locator('[data-section-rows]').last();
  const laneBox = (await lane.boundingBox())!;
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
