import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer, restoreQueueSession, TRACKS } from './music-browser-fixture';
import { settledBox } from './settle';
import { snapCarousel } from './playerGestures';

/* A queue long enough for its requests lane to scroll: the bug only shows once
   the panel under the finger has something to scroll. The context is a card
   now, so the length has to come from requests. */
async function mockEngine(page: Page) {
  await mockMusicEngine(page);
  await restoreQueueSession(page, { current: TRACKS[319], requests: TRACKS.slice(200, 230) });
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
  await openMiniPlayer(page, /Canción de biblioteca 320/);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();

  const stage = page.locator('[data-now-playing-tile="stage"]');
  const queue = page.locator('[data-now-playing-tile="queue"]');
  const browser = page.locator('[data-now-playing-tile="browser"]');
  await expect(stage).not.toHaveAttribute('inert', '');

  // The queue, scrolled, is the panel the swipe used to die on.
  await snapCarousel(page, 'queue');
  await expect(queue).not.toHaveAttribute('inert', '');
  const lane = queue.locator('section[data-section="manual"] [data-section-rows]');
  const laneBox = await settledBox(page, lane, (box) => box.y + 120);
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
