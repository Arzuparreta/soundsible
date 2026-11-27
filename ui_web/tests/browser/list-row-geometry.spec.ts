import { expect, test, type Page } from '@playwright/test';
import { dragTouch } from './playerGestures';
import { mockMusicEngine } from './music-browser-fixture';

const tracks = Array.from({ length: 40 }, (_, index) => ({
  id: `geometry-${index}`, title: `Halo canción ${index + 1}`, artist: `Halo artista ${index % 2}`,
  album: 'Halo álbum', duration: 230,
}));
const catalog = tracks.slice(0, 4).map(track => ({
  ...track, type: 'library_track', source: 'library', track_id: track.id, subtitle: track.artist,
  action_state: { in_library: true, playable: true },
}));
const rowSelector = '[data-song-row], [data-music-list-row], [data-library-artist-row], [data-catalog-row]';

async function mockLists(page: Page) {
  await mockMusicEngine(page);
  await page.route(url => url.pathname === '/api/library', route => route.fulfill({ json: {
    tracks, playlists: { Halo: tracks.map(track => track.id) }, settings: {}, podcast_subscriptions: [],
  } }));
  await page.route('**/api/library/favourites', route => route.fulfill({ json: tracks.map(track => track.id) }));
  await page.route(url => url.pathname === '/api/library/saved', route => route.fulfill({ json: { saved: tracks.map(track => ({
    keys: [`lib:${track.id}`], title: track.title, artist: track.artist, favourite: true,
  })) } }));
  await page.route('**/api/library/artists', route => route.fulfill({ json: { artists: [0, 1].map(index => ({
    id: `artist-${index}`, name: `Halo artista ${index}`, track_count: 20, album_count: 1,
  })) } }));
  await page.route('**/api/catalog/search?**', route => route.fulfill({ json: {
    items: catalog, sections: [{ id: 'songs', item_ids: catalog.map(item => item.id) }],
  } }));
}

async function size(page: Page, selected: 'compact' | 'normal' | 'large') {
  await page.evaluate(async selected => {
    const path = '/player/src/stores/index.ts';
    (await import(/* @vite-ignore */ path)).actions.setInterfaceSize(selected);
  }, selected);
  await expect(page.locator('html')).toHaveAttribute('data-interface-size', selected);
}

/** Check actual boxes, including descendants; matching slot sizes alone misses
 * text and artwork overflowing a perfectly spaced virtual window. */
async function assertRows(page: Page) {
  await expect(page.locator(rowSelector).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator(rowSelector).evaluateAll(elements => {
    const token = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
    const rows = elements.filter(element => !element.closest('[inert], [aria-hidden="true"]'));
    const errors: string[] = [];
    rows.forEach((row, index) => {
      const box = row.getBoundingClientRect();
      if (Math.abs(box.height - token) > 1) errors.push(`row ${index}: height ${box.height}, expected ${token}`);
      const next = rows[index + 1]?.getBoundingClientRect();
      if (next && next.top < box.bottom - 1) errors.push(`row ${index}: overlaps next by ${box.bottom - next.top}`);
      for (const child of row.querySelectorAll<HTMLElement>('a, button, [role="button"], [data-row-cover], span, div')) {
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < box.left - 1 || rect.right > box.right + 1) {
          errors.push(`row ${index}: child overflows (${child.textContent?.slice(0, 50)})`);
        }
      }
    });
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal document overflow');
    return errors;
  })).toEqual([]);
}

for (const density of ['compact', 'normal', 'large'] as const) {
  test(`${density}: equivalent song lists share row geometry, including mixed search and held catalog songs`, async ({ page }) => {
    await mockLists(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of [
      '/songs', '/songs?q=Halo%20artista', '/favourites', '/playlists/Halo',
      '/artist/Halo%20artista%200?view=library', '/album/Halo%20%C3%A1lbum?artist=Halo%20artista%200&view=library',
      '/search?q=Halo',
    ]) await test.step(route, async () => {
      await page.goto(`/player/#${route}`);
      // Library keeps its search input while its hash parameters change.
      if (route.includes('&q=')) await page.reload();
      await size(page, density);
      await assertRows(page);
      if (route.includes('&q=')) {
        const artists = page.locator('[data-library-artist-row], [data-music-list-row]:has([data-round])');
        await expect(artists.first()).toBeAttached();
        await expect(page.locator('[data-song-row], [data-music-list-row]:not(:has([data-round]))').first()).toBeAttached();
        const scroll = page.locator('[data-library-scroll]');
        await scroll.dispatchEvent('pointerdown');
        await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await assertRows(page);
        await expect(page.getByText('Halo canción 1', { exact: true })).toBeAttached();
      }
      if (route.startsWith('/search')) await expect(page.getByText(/En tu biblioteca$/).first()).toBeVisible();
    });
    expect(errors).toEqual([]);
  });
}

test('mounted mixed results follow live density and desktop/mobile breakpoint changes', async ({ page }) => {
  await mockLists(page);
  await page.goto('/player/#/songs?q=Halo%20artista');
  for (const width of [1366, 390, 1024, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const density of ['large', 'compact', 'normal'] as const) {
      await size(page, density);
      await assertRows(page);
    }
  }
});

test('collection search uses the full toolbar on desktop and opens from the app bar on phones', async ({ page, isMobile }) => {
  await mockLists(page);
  const routes = ['/favourites', '/playlists', '/playlists/Halo',
    '/artist/Halo%20artista%200?view=library',
    '/album/Halo%20%C3%A1lbum?artist=Halo%20artista%200&view=library'];
  if (!isMobile) routes.unshift('/songs');
  for (const route of routes) await test.step(route, async () => {
    await page.goto(`/player/#${route}`);
    if (isMobile) {
      const field = page.getByRole('searchbox');
      await expect(field).toHaveCount(0);
      const command = page.locator('[data-app-bar]').getByRole('button', { name: 'Filtrar esta lista' });
      await expect(command).toHaveAttribute('aria-expanded', 'false');
      await command.tap();
      await expect(field).toBeFocused();
      await expect(command).toHaveAttribute('aria-expanded', 'true');
      return;
    }
    const toolbar = page.locator('main [data-page-toolbar]').filter({ has: page.getByRole('searchbox') });
    await expect(toolbar.getByRole('searchbox')).toBeVisible();
    expect(await toolbar.evaluate(element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const field = element.firstElementChild!.getBoundingClientRect();
      const last = element.lastElementChild!.getBoundingClientRect();
      const gutter = parseFloat(style.getPropertyValue('--gutter'));
      const insetLeft = box.left + gutter;
      const insetRight = box.right - gutter;
      return {
        inset: Math.abs(field.left - insetLeft) <= 1,
        fills: Math.abs(last.right - insetRight) <= 1,
        row: Math.abs((last.top + last.bottom) / 2 - (field.top + field.bottom) / 2) <= 1,
      };
    })).toEqual({ inset: true, fills: true, row: true });
  });
});

test('a continuous pull through the top reveals the filter and an upward swipe into the list dismisses it', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'CDP injects trusted touch gestures');
  await mockLists(page);
  await page.goto('/player/#/favourites');
  const surface = page.locator('[data-primary-scroll]');
  const field = page.getByRole('searchbox');
  await expect(surface.locator(rowSelector).first()).toBeVisible();
  await expect(field).toHaveCount(0);
  await dragTouch(page, '[data-primary-scroll]', { dx: 85 });
  await expect(field).toHaveCount(0);
  const position = () => surface.evaluate(element => element.scrollTop);
  await surface.evaluate(element => { element.scrollTop = 300; });
  await dragTouch(page, '[data-primary-scroll]', { dy: 60 });
  await expect(field).toHaveCount(0);
  await expect.poll(position).toBeGreaterThan(1);

  await surface.evaluate(element => { element.scrollTop = 60; });
  await dragTouch(page, '[data-primary-scroll]', { dy: 150 }, 12);
  await expect.poll(position).toBe(0);
  await expect(field).toBeVisible();
  await expect(field).not.toBeFocused();
  await dragTouch(page, '[data-primary-scroll]', { dy: -65 });
  await expect.poll(position).toBeGreaterThan(24);
  await expect(field).toHaveCount(0);
  await surface.evaluate(element => { element.scrollTop = 0; });
  await expect(field).toHaveCount(0);
});

test('an active filter stays open while scrolling, and an empty filter stays open on the way back up', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Only the touch shell conceals collection search');
  await mockLists(page);
  await page.goto('/player/#/favourites');
  const surface = page.locator('[data-primary-scroll]');
  const field = page.getByRole('searchbox');
  const command = page.locator('[data-app-bar]').getByRole('button', { name: 'Filtrar esta lista' });
  await expect(surface.locator(rowSelector).first()).toBeVisible();
  await surface.evaluate(element => { element.scrollTop = 300; });
  await command.tap();
  await expect(field).toBeFocused();
  await surface.evaluate(element => { element.scrollTop = 340; });
  await expect(field).toBeFocused();
  await field.blur();
  await surface.evaluate(element => { element.scrollTop = 200; });
  await expect(field).toBeVisible();

  await field.fill('Halo');
  await field.blur();
  await surface.evaluate(element => { element.scrollTop = 400; });
  await expect(field).toHaveValue('Halo');
  await field.clear();
  await field.blur();
  await surface.evaluate(element => { element.scrollTop = 520; });
  await expect(field).toHaveCount(0);
});

test('an empty filter can be swiped closed on a short collection', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'CDP injects trusted touch gestures');
  await mockLists(page);
  await page.goto('/player/#/artists');
  const surface = page.locator('[data-primary-scroll]');
  const field = page.getByRole('searchbox');
  await expect(surface.getByText('Halo artista 0')).toBeVisible();
  await dragTouch(page, '[data-primary-scroll]', { dy: 60 });
  await expect(field).toBeVisible();
  await dragTouch(page, '[data-primary-scroll]', { dy: -55 });
  await expect(field).toHaveCount(0);
});

test('the concealed field follows the drag and returns to rest when the touch is cancelled', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Only the touch shell conceals collection search');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockLists(page);
  await page.goto('/player/#/favourites');
  const surface = page.locator('[data-primary-scroll]');
  const reveal = page.locator('[data-search-reveal]');
  const field = page.getByRole('searchbox');
  await expect(surface.locator(rowSelector).first()).toBeVisible();

  const touch = (type: string, y?: number) => surface.evaluate((element, { type, y }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: y === undefined ? [] : [{ clientX: 180, clientY: y }] });
    element.dispatchEvent(event);
  }, { type, y });
  const height = () => reveal.evaluate(element => element.getBoundingClientRect().height);

  await touch('touchstart', 200);
  await touch('touchmove', 221);
  const partial = await height();
  expect(partial).toBeGreaterThan(0);
  await expect(field).toHaveCount(0);
  await touch('touchcancel');
  await expect.poll(height).toBe(0);

  await touch('touchstart', 200);
  await touch('touchmove', 235);
  await touch('touchend');
  await expect(field).toBeVisible();
  await expect.poll(height).toBeGreaterThan(partial);
  await expect(field).not.toBeFocused();
});
