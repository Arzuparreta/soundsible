import { expect, test, type Page } from '@playwright/test';

/*
 * What the pill has to survive: a hard-edged, maximum-contrast backdrop
 * scrolling underneath it. The blur that is supposed to soften that is painted
 * by one engine of the three (see src/styles/glassTokens.test.ts), so this
 * measures the surface every engine actually draws — the fill on its own.
 */

const tracks = Array.from({ length: 40 }, (_, index) => ({
  id: `legible-${index}`,
  title: `Canción ${index}`,
  artist: 'Artista de prueba',
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
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

/** Darkest and brightest pixel of a screenshot, read back through a canvas —
    the browser is the only PNG decoder this suite has. */
async function range(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
    let min = 255;
    let max = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return Math.round(max - min);
  }, png);
}

test.beforeEach(async ({ page }) => { await mockEngine(page); });

test('the library never reads through the mini-player', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'the floating pill is the compact layout');
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción 39/ }).click();
  const pill = page.locator('[data-omni-player]');
  await expect(pill).toBeVisible();

  // The worst backdrop there is: 6px black-on-white bars, painted into the rows
  // so they live in the same layers the real list does.
  await page.addStyleTag({
    content: `
      [data-music-list-row], [data-music-list-row] * {
        background: repeating-linear-gradient(90deg, #000 0 6px, #fff 6px 12px) !important;
        color: transparent !important;
        border-color: transparent !important;
      }
    `,
  });
  await page.locator('[data-primary-scroll]').first().evaluate((element) => { element.scrollTop = 90; });
  await expect.poll(() => page.locator('[data-music-list-row]').first().isVisible()).toBe(true);
  await page.waitForTimeout(400);

  const box = (await pill.boundingBox())!;
  // A band inside the pill, above its own text and clear of its rounded corners.
  const through = await range(page, { x: box.x + 30, y: box.y + 6, width: box.width - 60, height: 8 });
  // The same bars with nothing over them, so a rig that stopped painting the
  // pattern fails loudly instead of passing on a blank page.
  const bare = await range(page, { x: box.x + 30, y: box.y - 24, width: box.width - 60, height: 8 });

  expect(bare).toBeGreaterThan(150);
  // Measured: 88 at the old 0.66 fill, 21 at the current one. 45 leaves room for
  // antialiasing and device pixel ratios without letting an edge back through.
  expect(through).toBeLessThan(45);
});
