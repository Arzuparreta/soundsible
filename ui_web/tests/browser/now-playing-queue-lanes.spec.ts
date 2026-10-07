import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer, restoreQueueSession, TRACKS } from './music-browser-fixture';
import { settle } from './settle';
import { snapPlayerCarousel } from './playerGestures';

/**
 * The queue shows what the listener decided — the song playing and the songs
 * they asked for — and then what the music continues into, as cards: the
 * collection it was played from, and Autoplay. A library of 320 songs used to
 * pour 319 rows into the queue; it is one card now.
 */

const newest = TRACKS[319];
/** Enough requests that their lane cannot fit and has to scroll itself. */
const REQUESTS = TRACKS.slice(200, 230);

async function openQueuePanel(page: Page, song = /Canción de biblioteca 320/) {
  await openMiniPlayer(page, song);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  const queue = page.locator('[data-now-playing-tile="queue"]');
  await expect(queue).toBeVisible();
  await settle(page, '[data-now-playing-tile="queue"]');
  return queue;
}

/** Play the song at the top of the library — the list reads newest first. */
async function playFromLibrary(page: Page) {
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  return openQueuePanel(page);
}

/** Come back to a paused session with a long lane of requests. */
async function restoreLongQueue(page: Page) {
  await restoreQueueSession(page, { current: newest, requests: REQUESTS, context: TRACKS.slice(0, 5) });
  await page.goto('/player/#/library?view=songs');
  return openQueuePanel(page);
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

test('the library continues as one card, not as a row per song', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the phone gets the same cards on its queue page');
  const queue = await playFromLibrary(page);

  // Only the song that is playing is a row.
  await expect(queue.locator('[data-drag-row]')).toHaveCount(1);
  const context = queue.locator('[data-queue-card="context"]');
  await expect(context).toBeVisible();
  // `text-transform: uppercase` is CSS only, so the DOM keeps the real casing.
  await expect(context).toContainText('Tu biblioteca');
  await expect(context.locator('[data-card-detail]')).toHaveText('Biblioteca · 319 pistas');

  // Autoplay is there too, off in this account, and says so in words.
  const autoplay = queue.locator('[data-queue-card="autoplay"]');
  await expect(autoplay).toHaveAttribute('data-dimmed', '');
  await expect(autoplay.locator('[data-card-detail]')).toHaveText('Desactivada');
  await expect(autoplay.getByRole('switch', { name: 'Reproducción automática' })).toHaveAttribute('aria-checked', 'false');

  const violations = await new AxeBuilder({ page }).include('[data-now-playing-tile="queue"]').analyze();
  expect(violations.violations).toEqual([]);
});

test('removing the context keeps the song and hands over to Autoplay, which switches from its card', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop controls; the phone reaches them from the card menu');
  const settings: unknown[] = [];
  await page.route((url) => url.pathname === '/api/discovery/settings', async (route) => {
    if (route.request().method() !== 'GET') settings.push(route.request().postDataJSON());
    await route.fulfill({ json: { learning_enabled: true, autoplay_enabled: false } });
  });
  const queue = await playFromLibrary(page);

  await queue.getByRole('button', { name: 'Quitar Tu biblioteca de la cola' }).click();
  await expect(queue.locator('[data-queue-card="context"]')).toHaveCount(0);
  await expect(queue.locator('[data-drag-row]')).toHaveCount(1);
  await expect(page.locator('[data-omni-player]')).toContainText('Canción de biblioteca 320');

  // Keyboard, not pointer: the switch is a real control even while dimmed.
  const toggle = queue.getByRole('switch', { name: 'Reproducción automática' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(queue.locator('[data-queue-card="autoplay"]')).not.toHaveAttribute('data-dimmed', '');
  await expect.poll(() => settings).toContainEqual(expect.objectContaining({ autoplay_enabled: true }));
});

test('expanding the collection keeps the player open and exposes the real queue order', async ({ page, isMobile }) => {
  const queue = await restoreLongQueue(page);
  if (isMobile) await snapPlayerCarousel(page, 'now-playing', 'queue');
  const card = queue.locator('[data-queue-card="context"]');
  const expand = card.locator('[data-card-expand]');
  await expand.click({ position: { x: 24, y: 24 } });
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(1);
  const songs = queue.locator('[data-card-songs]');
  await expect(songs.locator('[data-drag-row]')).toHaveCount(5);
  const dropdown = card.locator('button[aria-expanded]').last();
  const remove = card.getByRole('button', { name: /Quitar .* de la cola/ });
  const left = await dropdown.boundingBox(); const right = await remove.boundingBox();
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
  const rows = songs.locator('[data-drag-row]');
  if (!isMobile) {
    const first = await rows.first().getAttribute('data-drag-row');
    await rows.first().dragTo(rows.nth(2));
    await expect(rows.nth(2)).toHaveAttribute('data-drag-row', first!);
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
  }
  const violations = await new AxeBuilder({ page }).include('[data-now-playing-tile="queue"]').analyze();
  expect(violations.violations).toEqual([]);
  await songs.getByRole('button', { name: /Canción de biblioteca [1-5].*Artista/ }).first().click();
  await expect(page.locator('[data-omni-player]')).toContainText(/Canción de biblioteca [1-5]/);
  await expect(queue.locator('[data-card-songs]')).toBeVisible();
  await card.locator('button[aria-expanded]').last().click();
  await expect(queue.locator('[data-card-songs]')).toHaveCount(0);
  await expect(queue.locator('[data-queue-card="autoplay"] [aria-expanded]')).toHaveCount(0);
});

test('a whole library stays expandable and its last upcoming song remains reachable', async ({ page, isMobile }) => {
  const queue = await playFromLibrary(page);
  if (isMobile) await snapPlayerCarousel(page, 'now-playing', 'queue');
  await queue.locator('[data-card-expand]').click({ position: { x: 24, y: 24 } });
  const lane = queue.locator('[data-card-songs] [data-section-rows]');
  await expect(lane).toBeVisible();
  await expect.poll(() => lane.evaluate(node => node.scrollHeight)).toBeGreaterThan(10000);
  await lane.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(lane).toContainText('Canción de biblioteca 1');
  expect(await lane.locator('[data-drag-row]').count()).toBeLessThan(30);
});

for (const kind of ['album', 'artist', 'playlist'] as const) {
  test(`${kind} cards expose every song in a long collection`, async ({ page, isMobile }) => {
    await restoreQueueSession(page, { current: newest, requests: [], context: TRACKS.slice(0, 40),
      descriptor: { id: `fixture-${kind}`, kind, label: `Collection ${kind}` } });
    await page.goto('/player/#/library?view=songs');
    const queue = await openQueuePanel(page);
    if (isMobile) await snapPlayerCarousel(page, 'now-playing', 'queue');
    await queue.locator('[data-card-expand]').click({ position: { x: 24, y: 24 } });
    const lane = queue.locator('[data-card-songs] [data-section-rows]');
    await expect(lane).toBeVisible();
    await expect(queue.locator('[data-card-songs]')).toContainText('Canción de biblioteca 1');
    await expect.poll(() => lane.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
    await lane.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(queue.locator('[data-card-songs]')).toContainText('Canción de biblioteca 40');
    expect(await lane.locator('[data-drag-row]').count()).toBeLessThan(30);
    await expect(queue.locator('[data-card-expand]')).toHaveAttribute('aria-expanded', 'true');
  });
}

test('section labels never land on top of each other', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  const queue = await restoreLongQueue(page);

  const heads = queue.locator('section[data-head] > div:first-child');
  await expect.poll(() => heads.count()).toBe(3);
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
    expect(above.bottom, `"${above.text}" overlaps "${below.text}"`).toBeLessThanOrEqual(below.top);
  }

  // A lane squeezed past its label is a lane showing none of its songs, which
  // is the same collapse seen from the other side. Polled rather than read
  // once: a lane that has not finished laying out measures zero.
  const laneRows = queue.locator('[data-section-rows]');
  await expect(laneRows).toHaveCount(2);
  await expect
    .poll(async () => {
      const heights = await laneRows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
      return Math.min(...heights);
    }, { message: 'every lane must show songs, not only its label' })
    .toBeGreaterThan(40);
  // However long the requests get, the continuation stays in sight.
  await expect(queue.locator('[data-queue-card="context"]')).toBeInViewport();
  await expect(queue.locator('[data-queue-card="autoplay"]')).toBeInViewport();
});

/**
 * On a phone the queue is one card of the pager, and the box holding its
 * sections fills with them and then almost never scrolls. The requests lane is
 * the one that gives way and scrolls; the cards close the list at the bottom
 * of the card, above the pager pill — with the pill's clearance under them and
 * no more.
 */
test('the queue fills its card the way the browser does, and its cards clear the pill', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, 'mobile-only regression');
  await restoreLongQueue(page);
  await snapPlayerCarousel(page, 'now-playing', 'queue');
  await settle(page, '[data-now-playing-tile="queue"]');

  const queue = page.locator('[data-now-playing-tile="queue"]');
  const requests = queue.locator('section[data-section="manual"] [data-section-rows]');
  await expect
    .poll(() => requests.evaluate((lane) => lane.scrollHeight - lane.clientHeight),
      { message: 'the requests must be long enough to scroll' })
    .toBeGreaterThan(0);

  await expect
    .poll(() => queue.evaluate((tile) => {
      const sections = [...tile.querySelectorAll('section[data-section]')];
      const last = sections[sections.length - 1] as HTMLElement;
      return tile.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    }), { message: 'the queue left a strip of empty panel under its last section' })
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

  await snapPlayerCarousel(page, 'now-playing', 'queue');
  await settle(page, '[data-now-playing-tile="queue"]');

  // Card and pill are read in the same frame: the pill, read back on its own
  // after a trip across the pager, can be caught still travelling.
  const rests = 'the last card rests just above the pager pill';
  await expect
    .poll(async () => {
      const air = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-now-playing-tile="queue"] [data-queue-card]')];
        const pill = document.querySelector('nav[aria-label="Paneles de NORMAL"]');
        if (!cards.length || !pill) return null;
        const bottom = Math.max(...cards.map((card) => card.getBoundingClientRect().bottom));
        return Math.round(pill.getBoundingClientRect().top - bottom);
      });
      if (air === null) return 'the queue has no cards or no pill';
      if (air < 0) return `the last card sits ${-air}px under the pager pill`;
      if (air > 24) return `${air}px of empty panel stands above the pager pill`;
      return rests;
    }, { message: 'the cards must end on the pill, with its clearance and no more' })
    .toBe(rests);
});
