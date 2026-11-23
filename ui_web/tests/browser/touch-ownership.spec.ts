import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer, restoreQueueSession, TRACKS } from './music-browser-fixture';

test.use({ reducedMotion: 'no-preference' });

test('native touches release list scrolling and retain player pull-down dismissal', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'trusted touch injection and listener inspection use CDP');
  await mockMusicEngine(page);
  // A request lane long enough to scroll: the list under the finger.
  await restoreQueueSession(page, { current: TRACKS[319], requests: TRACKS.slice(200, 230) });
  await page.goto('/player/#/library?view=songs');
  await openMiniPlayer(page, /Canción de biblioteca 320/);
  await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(1).tap();
  const surface = page.locator('[data-player-surface-open]');
  const body = surface.locator('[data-now-playing-tile="queue"] section[data-section="manual"] [data-section-rows]');
  await expect(body).toBeVisible();
  await expect(surface.locator('[data-now-playing-tile="queue"]')).not.toHaveAttribute('inert', '');
  await expect.poll(() => body.evaluate(element => Math.abs(element.closest('[data-now-playing-tile]')!.getBoundingClientRect().left
    - element.closest('[data-now-playing-carousel]')!.getBoundingClientRect().left))).toBeLessThan(2);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const blocking = async () => {
    const { result } = await session.send('Runtime.evaluate', { expression: 'document.querySelector("[data-player-surface-open]")' });
    const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
    return listeners.filter(item => item.type === 'touchmove' && !item.passive).length;
  };
  const box = (await body.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 170) };
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', dy = 0) => {
    await session.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x: point.x, y: point.y + dy }],
    });
    // Native scrolling is asynchronous after ownership is released. Pace the
    // finger through display frames instead of coalescing start/move/end.
    await page.waitForTimeout(20);
  };
  expect(await blocking()).toBe(0);
  // A gesture starting inside a list already scrolled down is entirely native.
  await body.evaluate(element => { element.scrollTop = 200; });
  await touch('touchStart');
  expect(await blocking()).toBe(0);
  await touch('touchMove', -50);
  await touch('touchMove', -110);
  await touch('touchEnd');
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  // At the top the first upward move rejects dismissal and releases ownership.
  await body.evaluate(element => { element.scrollTop = 0; });
  await touch('touchStart');
  expect(await blocking()).toBe(1);
  await touch('touchMove', -50);
  await touch('touchMove', -100);
  expect(await blocking()).toBe(0);
  await touch('touchEnd');
  // A new downward gesture can still cancel native scrolling and dismiss.
  await body.evaluate(element => { element.scrollTop = 0; });
  await touch('touchStart');
  await touch('touchMove', 30);
  await touch('touchMove', 65);
  await touch('touchMove', 140);
  await expect(surface).toHaveAttribute('style', /translateY/);
  await touch('touchEnd');
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await session.detach();
});
