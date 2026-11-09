import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

const ARTIST = 'Josh Woodward';
const ALBUM = 'Ashes';
const tracks = Array.from({ length: 3 }, (_, index) => ({
  id: `entity-local-${index}`, title: `Local song ${index + 1}`, artist: ARTIST, album: ALBUM, duration: 180,
}));
const catalog = Array.from({ length: 6 }, (_, index) => ({
  id: `deezer:track:${index + 1}`, type: 'track', source: 'deezer', title: `Catalog song ${index + 1}`,
  artist: ARTIST, subtitle: ARTIST, album: ALBUM, duration: 180,
  external_ids: { deezer_id: String(index + 1) },
  raw: { deezer_id: String(index + 1), track_number: index + 1, disc_number: 1 },
}));
const subscription = {
  id: 'entity-podcast', title: 'Listening closely: stories behind the records we love',
  author: 'Soundsible Sessions', rss_url: 'https://example.test/episodes.xml', image_url: null,
};
const rowSelector = '[data-music-list-row], [data-song-row], [data-catalog-row]';

async function mockEntities(page: Page, albumTitle = ALBUM) {
  await mockMusicEngine(page);
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'large');
  });
  await page.route(url => url.pathname === '/api/library', route => route.fulfill({ json: {
    tracks: tracks.map(track => ({ ...track, album: albumTitle })),
    playlists: {}, settings: {}, podcast_subscriptions: [subscription],
  } }));
  const reads = { artist: 0, album: 0 };
  const playbackRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/catalog/resolve' || path.startsWith('/api/static/stream/')) playbackRequests.push(path);
    if (path === '/api/playback/state' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      // Unlocking the idle audio context can publish a playing clock without
      // a track. A user playback command must actually select music.
      if (body?.is_playing && (body.track_id || body.track)) playbackRequests.push(path);
    }
  });
  await page.route(url => url.pathname === '/api/catalog/artist', route => {
    reads.artist++;
    return route.fulfill({ json: {
      name: ARTIST, resolved: true, deezer_id: 'artist-1', in_library: true,
      metadata: { nb_fans: 125700 }, top_tracks: catalog,
      albums: Array.from({ length: 7 }, (_, index) => ({
        deezer_id: `album-${index}`, title: `Release ${index + 1}`, cover: '', year: 2010 + index,
      })), singles_eps: [], related_artists: [], candidates: [],
    } });
  });
  await page.route(url => url.pathname === '/api/catalog/album', route => {
    reads.album++;
    return route.fulfill({ json: {
      title: albumTitle, artist: ARTIST, resolved: true, deezer_id: 'album-1', year: 2010,
      in_library: true, cover: '', tracklist: catalog.map(item => ({ ...item, album: albumTitle })),
    } });
  });
  await page.route(url => /^\/api\/catalog\/(artist|album)\/download$/.test(url.pathname),
    route => route.fulfill({ json: { job: null } }));
  await page.route('**/api/podcasts/feeds/**', route => route.fulfill({ json: {
    subscription, changed: false, episodes: Array.from({ length: 20 }, (_, index) => ({
      guid: `entity-episode-${index}`, title: `Episode ${index + 1}: Making room for music`,
      enclosure_url: `https://example.test/episode-${index}.mp3`, duration_sec: 1800,
      published_at: '2026-11-01T12:00:00Z',
    })),
  } }));
  return { reads, playbackRequests };
}

async function expectSingleToolbar(page: Page) {
  const toolbar = page.locator('[data-app-outlet] [data-entity-toolbar]');
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => toolbar.evaluate(element => {
    const box = element.getBoundingClientRect();
    const controlHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-h'));
    const errors: string[] = [];
    if (box.height > controlHeight + 2) errors.push(`toolbar ${box.height}px exceeds one ${controlHeight}px row`);
    const controls = [...element.querySelectorAll<HTMLElement>('button, select')]
      .filter(control => control.getBoundingClientRect().width > 0);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (Math.abs((rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2) > 2) {
        errors.push(`${control.getAttribute('aria-label') || control.textContent} is not on the toolbar row`);
      }
      if (rect.left < box.left - 1 || rect.right > box.right + 1) errors.push('control overflows toolbar');
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal document overflow');
    return errors;
  })).toEqual([]);
  return toolbar;
}

async function expectFullTitle(heading: Locator, title: string) {
  await expect(heading).toHaveText(title);
  expect(await heading.evaluate(element => {
    const elements = [element, ...element.querySelectorAll<HTMLElement>('button')];
    return elements.every(node => {
      const style = getComputedStyle(node);
      return node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1
        && !['hidden', 'clip'].includes(style.overflowY)
        && !/^[1-9]/.test(style.webkitLineClamp);
    });
  })).toBe(true);
}

for (const kind of ['album', 'artist'] as const) {
  test(`${kind}: 360px Spanish Large reaches songs after one toolbar and switches content without playing`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const fixture = await mockEntities(page);
    const path = kind === 'album'
      ? `/album/${ALBUM}?artist=${encodeURIComponent(ARTIST)}&view=discover&deezer_id=album-1`
      : `/artist/${encodeURIComponent(ARTIST)}?view=discover&deezer_id=artist-1`;
    await page.goto(`/player/#${path}`);
    const outlet = page.locator('[data-app-outlet]');
    await expect(outlet).toHaveCount(1);
    await expect(outlet.locator(rowSelector)).toHaveCount(6);
    const toolbar = await expectSingleToolbar(page);
    await expect(toolbar.getByRole('button', { name: 'Reproducir', exact: true })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: /^Opciones/ })).toBeVisible();
    const mode = toolbar.getByRole('combobox', { name: 'Contenido mostrado', exact: true });
    await expect(mode).toHaveValue('discover');
    await expect(mode.locator('option')).toHaveCount(2);
    await expect(mode.locator('option[value="library"]')).toContainText('3');
    // A second segment bar would recreate the rejected three-layer header.
    const header = outlet.locator('header');
    await expect(header.getByRole('button', { name: 'Descubrir', exact: true })).toHaveCount(0);
    await expect(header.getByRole('button', { name: /^Mi biblioteca/ })).toHaveCount(0);
    const first = outlet.locator(rowSelector).first();
    expect((await first.boundingBox())!.y).toBeLessThanOrEqual(kind === 'album' ? 280 : 320);

    await mode.selectOption('library');
    await expect(page).toHaveURL(/view=library/);
    await expect(outlet.locator(rowSelector)).toHaveCount(3);
    await expect(outlet.getByText('Local song 1', { exact: true })).toBeVisible();
    await mode.selectOption('discover');
    await expect(page).toHaveURL(/view=discover/);
    await expect(outlet.locator(rowSelector)).toHaveCount(6);
    expect(fixture.reads[kind]).toBe(1);
    expect(fixture.playbackRequests).toEqual([]);

    await toolbar.getByRole('button', { name: /^Opciones/ }).click();
    const menu = page.getByRole('dialog');
    await expect(menu.getByRole('button', { name: 'Aleatorio', exact: true })).toBeInViewport();
    await expect(menu.getByRole('button', { name: 'Guardar', exact: true })).toBeInViewport();
    await expect(menu.getByRole('button', { name: 'Añadir todas las canciones', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expectSingleToolbar(page);
    expect(fixture.playbackRequests).toEqual([]);
  });
}

for (const title of ['Breadcrumbs', 'Breadcrumbs — recordings from the long road home and other stories']) {
  test(`album title remains complete at 360px Large: ${title}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await mockEntities(page, title);
    await page.goto(`/player/#/album/${encodeURIComponent(title)}?artist=${encodeURIComponent(ARTIST)}&view=discover`);
    const heading = page.locator('[data-app-outlet] h1');
    await expectFullTitle(heading, title);
    const toolbar = await expectSingleToolbar(page);
    const headingBox = (await heading.boundingBox())!;
    const toolbarBox = (await toolbar.boundingBox())!;
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(toolbarBox.y);
  });
}

test('expanded artist discography keeps two complete columns at 320px Large', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockEntities(page);
  await page.goto(`/player/#/artist/${encodeURIComponent(ARTIST)}?view=discover`);
  const toggle = page.getByRole('button', { name: 'Ver todos: Álbumes', exact: true });
  const gridId = await toggle.getAttribute('aria-controls');
  await toggle.click();
  await expect(page.locator(`button[aria-controls="${gridId}"]`)).toHaveAttribute('aria-expanded', 'true');
  const grid = page.locator(`[id="${gridId}"]`);
  const cards = grid.getByRole('link');
  await expect(cards).toHaveCount(7);
  await page.evaluate(() => document.fonts.ready);
  const first = (await cards.nth(0).boundingBox())!;
  const second = (await cards.nth(1).boundingBox())!;
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
  expect(first.x + first.width).toBeLessThanOrEqual(second.x + 1);
  expect(second.x + second.width).toBeLessThanOrEqual(320);
  expect(await grid.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('a long podcast identity leaves its first episode visible below one control row', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockEntities(page);
  await page.goto('/player/#/podcasts/entity-podcast');
  const outlet = page.locator('[data-app-outlet]');
  await expectFullTitle(outlet.locator('h1'), subscription.title);
  await expectSingleToolbar(page);
  const episode = outlet.getByText('Episode 1: Making room for music', { exact: true });
  await expect(episode).toBeInViewport();
  expect((await episode.boundingBox())!.y).toBeLessThanOrEqual(360);
  await expect(outlet.locator('header').getByRole('button', { name: 'Dejar de seguir', exact: true })).toHaveCount(0);
});
