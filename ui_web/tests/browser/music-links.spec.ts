import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

async function activate(page: Page, link: ReturnType<Page['getByRole']>, mobile: boolean) {
  if (mobile) await link.tap(); else await link.click();
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  // A real, long silent WAV keeps the engine from auto-skipping invalid fixture audio.
  const samples = 8000 * 180;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await page.route('**/api/static/stream/**', (route) => route.fulfill({ contentType: 'audio/wav', body: wav }));
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
