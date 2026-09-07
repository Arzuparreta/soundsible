import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const tracks = Array.from({ length: 80 }, (_, i) => ({
  id: `list-${i}`, title: `Canción ${i} con un título muy largo para comprobar el espacio disponible`,
  artist: 'Un artista con un nombre muy largo', duration: 180, album: 'Un álbum',
}));

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') body = { requires_login: true, user: { id: 'qa', username: 'qa', display_name: 'QA', role: 'admin', has_password: true } };
    if (path === '/api/library') body = { tracks, playlists: { Mix: tracks.slice(0, 3).map((t) => t.id) }, settings: {}, podcast_subscriptions: [] };
    if (path === '/api/podcasts/feeds/test-show/episodes') body = { subscription: { id: 'test-show', title: 'Un podcast' }, episodes: [{ guid: 'episode-1', title: 'Un episodio', enclosure_url: 'https://example.test/episode.mp3', duration_sec: 600 }] };
    if (path === '/api/library/saved') body = { saved: [{ keys: ['lib:list-0'], title: tracks[0].title, artist: tracks[0].artist, favourite: true }] };
    if (path === '/api/downloader/queue') body = { queue: [], is_processing: false, logs: [] };
    if (path === '/api/discovery/settings') body = { learning_enabled: true, autoplay_enabled: false };
    if (path === '/api/downloader/config') body = { quality: 'high', auto_update_ytdlp: false };
    if (path === '/api/discovery/music/feed') body = { sections: [] };
    if (path === '/api/catalog/search') body = {
      items: [{ id: 'deezer:42', type: 'track', source: 'deezer', title: 'Resultado del catálogo', artist: 'Otro artista', subtitle: 'Otro artista' }],
      sections: [{ id: 'songs', layout: 'rows', item_ids: ['deezer:42'], total: 1 }],
    };
    if (['/api/devices', '/api/paired-devices', '/api/pairing/sessions'].includes(path)) body = { devices: [], sessions: [] };
    await route.fulfill({ json: body });
  });
  await page.addInitScript(() => {
    localStorage.clear(); localStorage.setItem('lang', 'es'); localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

test.beforeEach(async ({ page }) => { await mockEngine(page); });

async function assertRows(page: Page, selector = '[data-music-list-row]') {
  const rows = page.locator(selector);
  await expect(rows.first()).toBeVisible();
  const geometry = await rows.evaluateAll((elements) => elements.filter((e) => {
    const r = e.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight && r.bottom > 0;
  }).map((row) => {
    const meta = row.querySelector('[data-row-meta]')!.getBoundingClientRect();
    const cover = row.querySelector('[data-row-cover]')!.getBoundingClientRect();
    const menu = row.querySelector('[data-row-menu]')?.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return { textWidth: meta.width, ordered: meta.right <= cover.left && (!menu || cover.right <= menu.left),
      contained: box.right <= innerWidth + 1 && box.left >= -1,
      menuSize: !menu || (menu.width >= 44 && menu.height >= 44),
      buttonCount: row.querySelectorAll('button').length, nested: !!row.querySelector('button button') };
  }));
  expect(geometry.length).toBeGreaterThan(0);
  for (const row of geometry) {
    expect(row.ordered).toBeTruthy(); expect(row.contained).toBeTruthy(); expect(row.menuSize).toBeTruthy();
    expect(row.textWidth).toBeGreaterThanOrEqual(100); expect(row.buttonCount).toBeLessThanOrEqual(2); expect(row.nested).toBeFalsy();
  }
}

test('shared examples retain geometry, nonredundant states and accessible targets at every mobile scale', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await page.goto('/player/#/preview');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const size of ['compact', 'normal', 'large']) {
      await page.evaluate((size) => document.documentElement.setAttribute('data-interface-size', size), size);
      const preview = page.locator('[data-mobile-list-preview]');
      await preview.scrollIntoViewIfNeeded();
      await assertRows(page, '[data-mobile-list-preview] [data-music-list-row]');
      const rows = preview.locator('[data-music-list-row]');
      await expect(rows.nth(0).locator('[data-row-favourite]')).toHaveCount(1);
      await expect(rows.nth(1).locator('[data-row-favourite]')).toHaveCount(0);
      await expect(rows.nth(2).locator('[data-row-favourite]')).toHaveCount(0);
      await expect(rows.nth(2).locator('[data-row-busy]')).toHaveCount(1);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute('data-interface-size', 'normal'));
  await page.locator('[data-mobile-list-preview]').scrollIntoViewIfNeeded();
  const axe = await new AxeBuilder({ page }).include('[data-mobile-list-preview]').analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('mobile-list-design.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await assertRows(page, '[data-mobile-list-preview] [data-music-list-row]');
  await page.screenshot({ path: info.outputPath('mobile-list-design-light.png') });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('[data-mobile-list-preview]').scrollIntoViewIfNeeded();
  await assertRows(page, '[data-mobile-list-preview] [data-music-list-row]');
});

test('library moves actions into the menu, keeps keyboard actions separate, and omits favourite marks in Favourites', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await page.goto('/player/#/');
  await assertRows(page);
  const row = page.locator('[data-music-list-row]').first();
  const title = await row.locator('[data-row-meta]').innerText();
  await row.locator('[data-row-menu]').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Añadir a favoritos', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.locator('[data-row-meta]')).toHaveText(title.replace(/\n/g, ''));
  await page.goto('/player/#/favourites');
  await expect(page.locator('[data-music-list-row]')).toHaveCount(1);
  await expect(page.locator('[data-row-favourite]')).toHaveCount(0);
  await page.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByText('Quitar de favoritos', { exact: true })).toBeVisible();
});

test('scroll cancellation and long press do not play the row or click through its menu', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await page.goto('/player/#/');
  const row = page.locator('[data-music-list-row]').first();
  const main = row.locator('[data-row-main]');
  await expect(main).toBeVisible();
  const event = { pointerId: 42, pointerType: 'touch', isPrimary: true, clientX: 200, clientY: 250 };
  await main.dispatchEvent('pointerdown', event);
  await main.dispatchEvent('pointermove', { ...event, clientY: 100 });
  await main.dispatchEvent('pointercancel', event);
  await main.dispatchEvent('click', { detail: 1 });
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  await main.dispatchEvent('pointerdown', event);
  await expect(page.getByRole('dialog')).toBeVisible();
  await main.dispatchEvent('pointerup', event);
  await main.dispatchEvent('click', { detail: 1 });
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('breakpoint changes restore desktop controls without losing virtual rows', async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  await page.goto('/player/#/');
  await expect(page.locator('[data-music-list-row]').first()).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.locator('[data-music-list-row]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Reproducir Canción/ }).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertRows(page);
});

test('catalogue download exists only in the sheet and opening it never saves or downloads', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  const mutations: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
  await page.goto('/player/#/search?q=resultado');
  const row = page.locator('[data-music-list-row]').filter({ hasText: 'Resultado del catálogo' }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('button')).toHaveCount(2);
  const before = mutations.length;
  await row.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Descargar', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Guardar en tu biblioteca', exact: true })).toBeVisible();
  expect(mutations.slice(before).filter((path) => /downloader|saved\/toggle|favourites\/toggle/.test(path))).toEqual([]);
});

test('episode download moves to the menu while the primary action remains play', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await page.goto('/player/#/podcasts/test-show');
  const row = page.locator('[data-music-list-row]').filter({ hasText: 'Un episodio' });
  await expect(row).toBeVisible();
  await expect(row.locator('button')).toHaveCount(2);
  await row.locator('[data-row-menu]').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /Descargar/ })).toBeVisible();
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
});

test('a native thumb scroll starting over the title leaves playback and favourites untouched', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-mobile', 'CDP native touch injection is Chromium-specific');
  const favouriteChanges: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/favourites/toggle')) favouriteChanges.push(request.url()); });
  await page.goto('/player/#/');
  await expect(page.locator('[data-music-list-row]').first()).toBeVisible();
  const scroll = page.locator('[data-library-scroll]');
  const bounds = await scroll.boundingBox();
  const session = await context.newCDPSession(page);
  const x = bounds!.x + bounds!.width * .60;
  const y = Math.min(bounds!.y + bounds!.height - 60, 650);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 32 }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  expect(favouriteChanges).toEqual([]);
  await session.detach();
});

test('queue editing follows an occurrence through consecutive moves and returns focus to its menu', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await page.goto('/player/#/');
  await page.locator('[data-row-main]').first().click();
  await page.locator('[data-omni-player]').click();
  const queue = page.locator('[data-now-playing-tile="queue"]');
  await page.locator('[data-now-playing-carousel]').evaluate(async (element) => {
    const carousel = element as HTMLElement;
    const target = carousel.querySelector<HTMLElement>('[data-now-playing-tile="queue"]')!;
    carousel.style.scrollBehavior = 'auto';
    carousel.scrollLeft += target.getBoundingClientRect().left - carousel.getBoundingClientRect().left;
    carousel.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(queue).not.toHaveAttribute('inert', '');
  const second = queue.locator('[data-drag-row]').nth(1);
  const id = await second.getAttribute('data-drag-row');
  await second.locator('[data-row-menu]').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mover', exact: true }).click();
  const editing = queue.locator(`[data-drag-row="${id}"]`);
  await editing.getByRole('button', { name: 'Bajar', exact: true }).click();
  await expect(queue.locator('[data-drag-row]').nth(2)).toHaveAttribute('data-drag-row', id!);
  await expect(editing.locator('[data-editing]')).toBeVisible();
  await editing.getByRole('button', { name: 'Subir', exact: true }).click();
  await expect(queue.locator('[data-drag-row]').nth(1)).toHaveAttribute('data-drag-row', id!);
  await editing.getByRole('button', { name: 'Listo', exact: true }).click();
  await expect(editing.locator('[data-row-menu]')).toBeFocused();
});
