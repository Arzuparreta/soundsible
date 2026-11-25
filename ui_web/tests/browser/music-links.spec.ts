import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';
import { showPlayerPanel } from './playerPanels';
import { settledBox } from './settle';

async function activate(page: Page, link: ReturnType<Page['getByRole']>, mobile: boolean) {
  if (mobile) await link.tap(); else await link.click();
}

async function mockArtist(page: Page | BrowserContext) {
  await page.route('**/api/catalog/artist**', (route) => route.fulfill({ json: {
    artist: 'Artista 7', resolved: true, in_library: true,
    top_tracks: [], albums: [], singles_eps: [], related_artists: [], candidates: [],
  } }));
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await mockArtist(page);
});

test('artist links navigate without playing and preserve browser history', async ({ page, isMobile }) => {
  await page.goto('/player/#/library?view=songs');
  const link = page.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await expect(link).toBeVisible();
  await expect(page.locator('button a, [role="button"] a, a a')).toHaveCount(0);
  await activate(page, link, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await expect(page.getByRole('heading', { name: 'Artista 7', exact: true })).toBeVisible();
  await expect(page.locator('[data-omni-player]')).not.toContainText('Canción de biblioteca');
  await page.goBack();
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  await expect(page.getByRole('link', { name: 'Artista 7', exact: true }).first()).toBeVisible();
});

test('artist and album details stay neutral and leave tab memory intact', async ({ page, isMobile }) => {
  await page.route('**/api/catalog/artist**', route => route.fulfill({ json: {
    artist: 'Artista 7', resolved: true, in_library: true,
    top_tracks: [], albums: [{ title: 'Disco del catálogo', deezer_id: '20' }],
    singles_eps: [], related_artists: [], candidates: [],
  } }));
  await page.goto('/player/#/search?q=disco');
  await expect(page.getByRole('searchbox')).toHaveValue('disco');

  await page.goto('/player/#/library?view=songs');
  await activate(page, page.getByRole('link', { name: 'Artista 7', exact: true }).first(), isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  const activeNav = page.locator('[aria-current="page"][data-nav-href]').filter({ visible: true });
  const searchTab = page.locator('[data-nav-href="/search"]').filter({ visible: true });
  const libraryTab = page.locator('[data-nav-href="/"]').filter({ visible: true });
  const libraryOwner = isMobile ? libraryTab : page.locator('[data-nav-href="/library?view=songs"]');
  await expect(activeNav).toHaveCount(0);

  const scope = page.getByRole('combobox', { name: 'Contenido mostrado' });
  await scope.selectOption('discover');
  await activate(page, page.getByRole('link', { name: 'Disco del catálogo', exact: true }), isMobile);
  await expect(page.getByRole('heading', { name: 'Disco del catálogo', exact: true })).toBeVisible();
  await expect(activeNav).toHaveCount(0);

  await page.goBack();
  await expect(scope).toHaveValue('discover');
  await expect(activeNav).toHaveCount(0);

  await activate(page, searchTab, isMobile);
  await expect(page).toHaveURL(/#\/search\?q=disco$/);
  await expect(page.getByRole('searchbox')).toHaveValue('disco');
  await expect(searchTab).toHaveAttribute('aria-current', 'page');

  await activate(page, libraryTab, isMobile);
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  await expect(libraryOwner).toHaveAttribute('aria-current', 'page');
});

test('opening an artist from the player on a utility tab stays neutral and leaves that tab untouched', async ({ page, isMobile }) => {
  const navigation = (href: string) => page.locator(`[data-nav-href="${href}"]`).filter({ visible: true });
  const settings = navigation('/settings');
  const activeNav = page.locator('[aria-current="page"][data-nav-href]').filter({ visible: true });
  await openMusicPlayer(page);
  if (isMobile) await page.keyboard.press('Escape');
  await activate(page, settings, isMobile);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');

  if (isMobile) await page.getByRole('button', { name: /^NORMAL:/ }).click();
  await showPlayerPanel(page, 'stage');
  const artistLink = page.locator('[data-player-surface-open] [data-now-playing-tile="stage"]')
    .getByRole('link', { name: 'Artista 7', exact: true });
  await activate(page, artistLink, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=discover/);
  await expect(activeNav).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');

  await page.goForward();
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=discover/);
  await expect(activeNav).toHaveCount(0);

  await activate(page, settings, isMobile);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(settings).toHaveAttribute('aria-current', 'page');
});

test('full player artist opens the general page while keeping the current song and queue', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  const stage = surface.locator('[data-now-playing-tile="stage"]');
  const song = await stage.getByRole('heading', { name: 'Canción de biblioteca 320', exact: true }).textContent();
  await showPlayerPanel(page, 'queue');
  const queue = surface.locator('[data-now-playing-tile="queue"]');
  const contextCard = queue.locator('[data-queue-card="context"]');
  await expect(contextCard).toBeVisible();
  const contextBefore = await contextCard.textContent();
  await showPlayerPanel(page, 'stage');
  const link = stage.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await activate(page, link, isMobile);
  // Entity details are neutral: opening the full discography highlights no section tab.
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=discover/);
  await expect(page.locator('[aria-current="page"][data-nav-href]').filter({ visible: true })).toHaveCount(0);
  if (isMobile) {
    // A phone's player covers the app, so it steps aside for the page.
    await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
    await expect(page.locator('[data-omni-player]')).toContainText(song!);
    const violations = await new AxeBuilder({ page }).include('[data-omni-player]').analyze();
    expect(violations.violations).toEqual([]);
    await page.getByRole('button', { name: /^NORMAL:/ }).click();
  } else {
    // Docked beside the app, the player stays open next to the page.
    await expect(surface).toBeVisible();
    await expect(stage.getByRole('heading', { name: song!, exact: true })).toBeVisible();
  }
  await showPlayerPanel(page, 'queue');
  await expect(queue.locator('[data-queue-card="context"]')).toHaveText(contextBefore!);
});

test('full player names the record under the artist and opens it', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  const stage = page.locator('[data-player-surface-open] [data-player-stage-mode="now-playing"]');
  const artist = stage.getByRole('link', { name: 'Artista 7', exact: true });
  const album = stage.getByRole('link', { name: 'Biblioteca de prueba', exact: true });
  await expect(album).toBeVisible();
  // After the artist on the same line: who, then the record, a step quieter.
  // Read once the stage has fitted its title: the line settles over a few
  // frames after the surface opens, and a reading taken during the fit sees a
  // line that is still wrapping.
  await expect.poll(async () => {
    const [artistBox, albumBox] = [await artist.boundingBox(), await album.boundingBox()];
    if (!artistBox || !albumBox) return 'not laid out';
    if (albumBox.x < artistBox.x + artistBox.width) return 'the record is not after the artist';
    const offset = Math.abs((albumBox.y + albumBox.height / 2) - (artistBox.y + artistBox.height / 2));
    return offset <= 2 ? 'same line' : `${offset}px apart`;
  }).toBe('same line');
  await activate(page, album, isMobile);
  await expect(page).toHaveURL(/#\/album\/Biblioteca%20de%20prueba\?artist=Artista\+7&view=discover/);
  // Over the app on a phone, the player steps aside; docked beside it, it stays.
  if (isMobile) await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  else await expect(page.locator('[data-player-surface-open]')).toBeVisible();
});

test('an album card opens the record from the line under its cover', async ({ page, isMobile }) => {
  // The tile is one target end to end. Only the cover and the title carry text
  // that reads like a link, so the credit and the song count are where a thumb
  // lands by accident — and they have to open the record like the rest of it.
  await page.route('**/api/library/albums**', (route) => route.fulfill({ json: { albums: [{
    id: 'al-1', title: 'Disco de prueba', album_artist: 'Artista 7', is_compilation: false,
    track_count: 12, duration: 2400, cover_track_id: null,
  }] } }));
  await page.goto('/player/#/library?view=songs');
  if (isMobile) {
    await page.getByRole('button', { name: 'Menú', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Álbumes', exact: true }).click();
  } else {
    await page.locator('aside').getByRole('link', { name: 'Álbumes', exact: true }).click();
  }
  const count = page.getByText('12 pistas', { exact: true });
  await expect(count).toBeVisible();
  // Aimed at the count and delivered to whatever is on top of it: the card's
  // own link is meant to be what catches it.
  if (isMobile) await count.tap({ force: true }); else await count.click({ force: true });
  await expect(page).toHaveURL(/#\/album\/Disco%20de%20prueba\?artist=Artista\+7&view=library&album_id=al-1/);
});

test('album cards open from their artwork, in the library and in search', async ({ page, isMobile }) => {
  // The cover fills most of the tile and is positioned (its image is laid over
  // it), so it is where nearly every tap lands. It used to paint over the
  // card's link and swallow the tap: the press showed, nothing opened.
  await page.route('**/api/library/albums**', (route) => route.fulfill({ json: {
    albums: [{ id: 'al-1', title: 'Disco de prueba', album_artist: 'Artista 7', is_compilation: false,
      track_count: 12, duration: 2400, cover_track_id: 'library-track-8' }],
    album: { id: 'al-1', title: 'Disco de prueba', album_artist: 'Artista 7' }, track_ids: ['library-track-8'],
  } }));
  await page.route('**/api/catalog/search?**', (route) => route.fulfill({ json: {
    items: [{ id: 'album:1', type: 'album', source: 'deezer', title: 'Disco buscado', artist: 'Artista 7',
      external_ids: { deezer_album_id: '20' } }],
    sections: [{ id: 'albums', item_ids: ['album:1'] }],
  } }));
  const tapArtwork = async (link: ReturnType<Page['getByRole']>) => {
    const box = (await link.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.width, box.height) / 2 };
    if (isMobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
  };

  await page.goto('/player/#/library?view=songs');
  if (isMobile) {
    await page.getByRole('button', { name: 'Menú', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Álbumes', exact: true }).click();
  } else {
    await page.locator('aside').getByRole('link', { name: 'Álbumes', exact: true }).click();
  }
  const card = page.getByRole('link', { name: 'Disco de prueba', exact: true });
  await expect(card).toBeVisible();
  await tapArtwork(card);
  await expect(page).toHaveURL(/#\/album\/Disco%20de%20prueba\?.*album_id=al-1/);
  await expect(page.getByRole('heading', { name: 'Disco de prueba', exact: true })).toBeVisible();

  await page.goto('/player/#/search?q=disco');
  const result = page.getByRole('link', { name: 'Disco buscado', exact: true });
  await expect(result).toBeVisible();
  await tapArtwork(result);
  await expect(page).toHaveURL(/#\/album\/Disco%20buscado\?.*deezer_id=20/);
});

test('desktop artist links support keyboard and a separate tab', async ({ page, isMobile, context }) => {
  test.skip(isMobile, 'Desktop keyboard and modifier behavior');
  // The new tab needs the same authenticated engine before its scripts run.
  await mockMusicEngine(context);
  await mockArtist(context);
  await page.goto('/player/#/library?view=songs');
  await expect(page.locator('html')).not.toHaveAttribute('data-booting', '');
  const link = page.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await expect(link).toBeVisible();
  await settledBox(page, link);
  // A modified click is the browser's: the app must leave it alone so the
  // browser can open a tab. Whether Chromium then spawns one is its own
  // business — and racy under Playwright's request interception, where a tab
  // it opens by itself can sit with its module graph never requested — so the
  // tab is opened here, at the address the link names.
  await page.evaluate(() => {
    const seen = window as unknown as { modifiedClick?: 'seen' | 'prevented' };
    const preventDefault = Event.prototype.preventDefault;
    document.addEventListener('click', (event) => { if (event.ctrlKey) seen.modifiedClick ??= 'seen'; }, true);
    Event.prototype.preventDefault = function (this: Event) {
      if (this.type === 'click' && (this as MouseEvent).ctrlKey) seen.modifiedClick = 'prevented';
      preventDefault.call(this);
    };
  });
  await link.click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => (window as unknown as { modifiedClick?: string }).modifiedClick)).toBe('seen');
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  const tab = await context.newPage();
  await tab.goto(new URL((await link.getAttribute('href'))!, page.url()).href);
  await expect(tab).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await expect(tab.getByRole('heading', { name: 'Artista 7', exact: true })).toBeVisible();
  await tab.close();
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
});


test('miniplayer artist navigates independently from expansion', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the compact pill is one press to open the player; see the mobile case below');
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  const mini = page.locator('[data-omni-player]');
  const link = mini.getByRole('link', { name: 'Artista 7', exact: true });
  await expect(link).toBeVisible();
  await activate(page, link, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=discover/);
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await expect(mini).toContainText('Canción de biblioteca 320');
});

/* On a phone the pill is one press to open the player. Every part of it that is
   not a transport control leads there — including the artist, which used to be
   a link that stole the tap, and the artwork, which used to swallow it and do
   nothing at all because it painted over the open button. */
test('every inert part of the compact pill opens the player on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the desktop bar keeps the artist link');
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  const mini = page.locator('[data-omni-player]');
  const surface = page.locator('[data-player-surface-open]');
  await expect(mini).toContainText('Artista 7');
  await expect(mini.getByRole('link', { name: 'Artista 7', exact: true })).toHaveCount(0);

  // Tapped by coordinate on purpose: `locator.tap()` now refuses these, because
  // the transparent open button covers them — which is the whole fix. What the
  // finger lands on has to reach that button, not what the DOM node would.
  for (const part of ['[data-omni-cover]', '[data-omni-meta]']) {
    // Measured once the pill is still: the previous turn of this loop closed the
    // surface, and a box read during that exit is a box the finger misses.
    const box = await settledBox(page, mini.locator(part));
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(surface).toHaveCount(1);
    await expect(page).toHaveURL(/#\/library\?view=songs$/);
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
  }
});

test('Explore from rows link verified YouTube performers while leaving channels and legacy items as text', async ({ page, isMobile }) => {
  await page.route('**/api/discovery/music/feed**', route => route.fulfill({ json: {
    v: 1,
    sections: [{
      id: 'explore_from_1',
      title: 'Explorar desde Semilla',
      title_key: 'explore_from',
      title_params: { title: 'Semilla' },
      item_ids: ['youtube:perf', 'youtube:chan', 'youtube:old'],
    }],
    items: [
      { id: 'youtube:perf', title: 'La vereda', artist: 'Extremoduro', artist_is_channel: false, external_ids: { youtube_id: 'perf' } },
      { id: 'youtube:chan', title: 'Directo subido', artist: 'Canal Cualquiera', artist_is_channel: true, external_ids: { youtube_id: 'chan' } },
      { id: 'youtube:old', title: 'Clip antiguo', artist: 'Sin Indicador', external_ids: { youtube_id: 'old' } },
    ],
  } }));
  await page.route('**/api/catalog/artist**', route => route.fulfill({ json: {
    artist: 'Extremoduro', resolved: true, in_library: false,
    top_tracks: [], albums: [], singles_eps: [], related_artists: [], candidates: [],
  } }));

  await page.goto('/player/#/search');
  const performerLink = page.getByRole('link', { name: 'Extremoduro', exact: true });
  await expect(performerLink).toBeVisible();
  await expect(page.getByText('Canal Cualquiera', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Canal Cualquiera', exact: true })).toHaveCount(0);
  await expect(page.getByText('Sin Indicador', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sin Indicador', exact: true })).toHaveCount(0);

  await activate(page, performerLink, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Extremoduro\?view=discover/);
  await expect(page.getByRole('heading', { name: 'Extremoduro', exact: true })).toBeVisible();
  await expect(page.locator('[aria-current="page"][data-nav-href]').filter({ visible: true })).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/#\/search$/);
  await expect(performerLink).toBeVisible();
});

test('a native scroll starting on an artist link does not navigate or play', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-mobile', 'Native touch injection uses CDP');
  await page.goto('/player/#/library?view=songs');
  const links = page.getByRole('link', { name: /^Artista / });
  await expect(links.first()).toBeVisible();
  const link = links.nth(5);
  const box = (await link.boundingBox())!;
  const session = await context.newCDPSession(page);
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x, y: y - step * 25 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.locator('[data-library-scroll]').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  await session.detach();
});
