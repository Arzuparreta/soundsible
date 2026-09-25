import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';
import { settledBox } from './settle';

async function activate(page: Page, link: ReturnType<Page['getByRole']>, mobile: boolean) {
  if (mobile) await link.tap(); else await link.click();
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/catalog/artist**', (route) => route.fulfill({ json: {
    artist: 'Artista 7', resolved: true, in_library: true,
    top_tracks: [], albums: [], singles_eps: [], related_artists: [], candidates: [],
  } }));
});

test('artist links navigate without playing and preserve browser history', async ({ page, isMobile }) => {
  await page.goto('/player/#/');
  const link = page.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await expect(link).toBeVisible();
  await expect(page.locator('button a, [role="button"] a, a a')).toHaveCount(0);
  await activate(page, link, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await expect(page.getByRole('heading', { name: 'Artista 7', exact: true })).toBeVisible();
  await expect(page.locator('[data-omni-player]')).not.toContainText('Canción de biblioteca');
  await page.goBack();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('link', { name: 'Artista 7', exact: true }).first()).toBeVisible();
});

test('full player artist opens the general page while keeping the current song and queue', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  const stage = surface.locator('[data-now-playing-tile="stage"]');
  const song = await stage.getByRole('heading', { name: 'Canción de biblioteca 320', exact: true }).textContent();
  const queueBefore = await surface.locator('[data-drag-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-drag-row')));
  const link = stage.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await activate(page, link, isMobile);
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await expect(page.locator('[data-omni-player]')).toContainText(song!);
  const violations = await new AxeBuilder({ page }).include('[data-omni-player]').analyze();
  expect(violations.violations).toEqual([]);
  await page.getByRole('button', { name: /^NORMAL:/ }).click();
  expect(await page.locator('[data-player-surface-open] [data-drag-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-drag-row')))).toEqual(queueBefore);
});

test('an album card opens the record from the line under its cover', async ({ page, isMobile }) => {
  // The tile is one target end to end. Only the cover and the title carry text
  // that reads like a link, so the credit and the song count are where a thumb
  // lands by accident — and they have to open the record like the rest of it.
  await page.route('**/api/library/albums**', (route) => route.fulfill({ json: { albums: [{
    id: 'al-1', title: 'Disco de prueba', album_artist: 'Artista 7', is_compilation: false,
    track_count: 12, duration: 2400, cover_track_id: null,
  }] } }));
  await page.goto('/player/#/');
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

  await page.goto('/player/#/');
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
  await page.goto('/player/#/');
  const link = page.getByRole('link', { name: 'Artista 7', exact: true }).first();
  await expect(link).toBeVisible();
  const opened = context.waitForEvent('page');
  await link.click({ modifiers: ['Control'] });
  const tab = await opened;
  await expect(tab).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await tab.close();
  await expect(page).toHaveURL(/#\/$/);
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
});


test('miniplayer artist navigates independently from expansion', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the compact pill is one press to open the player; see the mobile case below');
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  const mini = page.locator('[data-omni-player]');
  const link = mini.getByRole('link', { name: 'Artista 7', exact: true });
  await expect(link).toBeVisible();
  await activate(page, link, isMobile);
  await expect(page).toHaveURL(/#\/artist\/Artista%207\?view=library/);
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await expect(mini).toContainText('Canción de biblioteca 320');
});

/* On a phone the pill is one press to open the player. Every part of it that is
   not a transport control leads there — including the artist, which used to be
   a link that stole the tap, and the artwork, which used to swallow it and do
   nothing at all because it painted over the open button. */
test('every inert part of the compact pill opens the player on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the desktop bar keeps the artist link');
  await page.goto('/player/#/');
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
    await expect(page).toHaveURL(/#\/$/);
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
  }
});

test('a native scroll starting on an artist link does not navigate or play', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium-mobile', 'Native touch injection uses CDP');
  await page.goto('/player/#/');
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
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  await session.detach();
});
