import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, silentWav } from './music-browser-fixture';

const mediaPosition = (page: Page) => page.evaluate(async () => {
  const { audioService } = await import('/player/src/lib/audio.ts');
  return audioService.snapshot().position;
});

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/static/stream/**', route => {
    const range = route.request().headers().range;
    const match = range?.match(/bytes=(\d+)-(\d*)/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), silentWav.length - 1) : silentWav.length - 1;
    return route.fulfill({ status: match ? 206 : 200, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${silentWav.length}` } : {}) },
      body: silentWav.subarray(start, end + 1) });
  });
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await expect(page.locator('[data-omni-seek] input')).toBeEnabled();
  await expect.poll(() => page.evaluate(async () => {
    const { audioService } = await import('/player/src/lib/audio.ts');
    return audioService.snapshot().duration;
  })).toBe(180);
});

test('seek is keyboard accessible and leaves transport targets clear at every density', async ({ page }) => {
  const pill = page.locator('[data-omni-player]');
  // Use the stable scope as translations are shared with the full player.
  const seek = page.locator('[data-omni-seek] input');
  await seek.focus();
  await seek.press('Home');
  await seek.press('ArrowRight');
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThanOrEqual(1);
  for (const size of ['compact', 'normal', 'large']) {
    await page.evaluate(size => { document.documentElement.dataset.interfaceSize = size; }, size);
    const bounds = (await seek.boundingBox())!;
    for (const button of await pill.getByRole('button').all()) {
      const box = await button.boundingBox();
      if (box) expect(box.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
    }
  }
  expect((await new AxeBuilder({ page }).include('[data-omni-player]').analyze()).violations).toEqual([]);
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
});

test('mouse seeks without opening the full player', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse interaction');
  const seek = page.locator('[data-omni-seek] input');
  const box = (await seek.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 18);
  await expect.poll(() => mediaPosition(page)).toBeGreaterThan(85);
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
});

test('real touch holds, previews and releases without dismissing the pill', async ({ page, context, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'CDP provides real multi-event touch input');
  const seek = page.locator('[data-omni-seek] input');
  const box = (await seek.boundingBox())!;
  const client = await context.newCDPSession(page);
  const point = { x: box.x + box.width * 0.7, y: box.y + 18 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(page.locator('[data-omni-seek]')).toHaveAttribute('data-seeking', '');
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: box.x + box.width * 0.3 }] });
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(50);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('[data-omni-player]')).toBeVisible();
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(50);
  await expect(page.locator('[data-omni-seek]')).not.toHaveAttribute('data-seeking');
  await expect.poll(() => mediaPosition(page)).toBeGreaterThan(50);
});


test('a brief touch inside the rail opens Now Playing without seeking', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch interaction');
  const seek = page.locator('[data-omni-seek] input');
  const box = (await seek.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.8, box.y + 20);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  await expect.poll(async () => Number(await seek.inputValue())).toBeLessThan(10);
});


test('keyboard seek changes paused audio without starting playback', async ({ page }) => {
  await page.locator('[data-omni-player]').getByRole('button', { name: 'Pausar', exact: true }).click();
  const seek = page.locator('[data-omni-seek] input');
  await seek.focus();
  await seek.press('Home');
  for (let step = 0; step < 5; step++) await seek.press('ArrowRight');
  await expect.poll(() => mediaPosition(page)).toBeCloseTo(5, 0);
  await expect(page.locator('[data-omni-player]').getByRole('button', { name: 'Reproducir', exact: true })).toBeVisible();
});

test('small and landscape viewports retain separate seek and button hit areas', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile geometry');
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const size of ['compact', 'normal', 'large']) {
      await page.evaluate(size => { document.documentElement.dataset.interfaceSize = size; }, size);
      const seek = (await page.locator('[data-omni-seek] input').boundingBox())!;
      expect(seek.x).toBeGreaterThanOrEqual(0);
      expect(seek.x + seek.width).toBeLessThanOrEqual(viewport.width);
      for (const button of await page.locator('[data-omni-player]').getByRole('button').all()) {
        const box = await button.boundingBox();
        if (box) expect(box.y).toBeGreaterThanOrEqual(seek.y + seek.height);
      }
    }
  }
});
