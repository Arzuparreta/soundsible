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

test('holding anywhere acquires one relative seek and never triggers the underlying control', async ({ page, context, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'CDP provides real multi-event touch input');
  const pill = page.locator('[data-omni-player]');
  await pill.getByRole('button', { name: 'Pausar', exact: true }).click();
  const box = (await pill.boundingBox())!;
  const client = await context.newCDPSession(page);
  const targets = [pill.locator('[data-omni-cover]'), pill.locator('[data-omni-meta]'),
    pill.getByRole('button', { name: 'Reproducir', exact: true }), pill.getByRole('button', { name: 'Siguiente', exact: true })];
  const points = [{ x: box.x + box.width / 2, y: box.y + 2 },
    { x: box.x + 2, y: box.y + box.height / 2 }, { x: box.x + box.width - 2, y: box.y + box.height / 2 }];
  for (const target of targets) {
    const rect = (await target.boundingBox())!;
    points.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  for (const point of points) {
    await page.evaluate(async () => {
      const { actions } = await import('/player/src/stores/index.ts');
      actions.seek(100);
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(250);
    await expect(page.locator('[data-omni-seek]')).not.toHaveAttribute('data-seeking');
    await expect.poll(() => mediaPosition(page)).toBeCloseTo(100, 0);
    await expect(page.locator('[data-omni-seek]')).toHaveAttribute('data-seeking', '');
    const delta = point.x < 120 ? 60 : -60;
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + delta }] });
    const preview = Number(await page.locator('[data-omni-seek] input').inputValue());
    expect(delta < 0 ? preview < 100 : preview > 100).toBe(true);
    await expect.poll(() => mediaPosition(page)).toBeCloseTo(100, 0);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => mediaPosition(page)).toBeCloseTo(preview, 0);
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Canción de biblioteca 320');
    await expect(pill.getByRole('button', { name: 'Reproducir', exact: true })).toBeVisible();
    await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
    await expect(page.locator('[data-omni-seek]')).not.toHaveAttribute('data-seeking');
  }
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
      // Resize and density changes can settle between separate boundingBox
      // calls. Read every rectangle in one frame, then wait for the layout.
      await expect.poll(() => page.locator('[data-omni-player]').evaluate((player) => {
        const seek = player.querySelector('[data-omni-seek] input')!.getBoundingClientRect();
        const buttons = [...player.querySelectorAll('button')].filter(button => button.getClientRects().length);
        return seek.left >= 0 && seek.right <= window.innerWidth
          && buttons.every(button => button.getBoundingClientRect().top >= seek.bottom);
      })).toBe(true);
    }
  }
});


test('an early touch drag cannot run the native range without seek feedback', async ({ page, context, browserName, isMobile }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'real Chromium touch sequence');
  const pill = page.locator('[data-omni-player]');
  await pill.getByRole('button', { name: 'Pausar', exact: true }).click();
  await page.evaluate(async () => {
    const { actions } = await import('/player/src/stores/index.ts');
    actions.seek(100);
  });
  const box = (await pill.boundingBox())!;
  const client = await context.newCDPSession(page);
  const point = { x: box.x + box.width * 0.4, y: box.y + 2 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + 70 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('[data-omni-seek]')).not.toHaveAttribute('data-seeking');
  await expect.poll(() => mediaPosition(page)).toBeCloseTo(100, 0);
  await expect(pill).toBeVisible();
  await expect(page.locator('[data-player-surface-open]')).toHaveCount(0);
});
