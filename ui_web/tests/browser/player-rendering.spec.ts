import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

test.use({ reducedMotion: 'no-preference' });

const bytes = Buffer.from(readFileSync(new URL('./fixtures/progressive-preview.mp3.b64', import.meta.url), 'utf8'), 'base64');
test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/static/stream/**', route => route.fulfill({ contentType: 'audio/mpeg', body: bytes }));
});

test('wallpaper retains artwork and themes and parks only when hidden', async ({ page }) => {
  await page.route('**/api/static/cover/**', route => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#b03060"/></svg>' }));
  await openMusicPlayer(page);
  await page.locator('[data-player-stage-mode="now-playing"]').getByRole('button', { name: 'Pausar', exact: true }).click();
  const backdrop = page.locator('[data-player-surface-open] [data-player-backdrop="active"]');
  await expect(backdrop).toBeVisible();
  const appearance = () => page.evaluate(() => {
    // A cover-size update can swap the crossfade layers between locator
    // resolution and evaluation. Read the currently active layer atomically.
    const element = document.querySelector('[data-player-surface-open] [data-player-backdrop="active"]')!;
    const css = getComputedStyle(element);
    return { image: css.backgroundImage, filter: css.filter, duration: css.animationDuration,
      timing: css.animationTimingFunction, transition: css.transitionDuration };
  });
  await expect.poll(async () => (await appearance()).duration).toBe('38s');
  const dark = await appearance();
  expect(dark.image).toContain('/api/static/cover/');
  expect(dark.filter).toContain('blur(62px)');
  expect(dark.duration).toBe('38s');
  expect(dark.timing).toMatch(/^steps\(380(?:, end)?\)$/);
  expect(dark.transition).toContain('0.72s');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(async () => (await appearance()).filter).toContain('blur(64px)');
  expect((await appearance()).image).toBe(dark.image);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('html')).not.toHaveAttribute('data-page-hidden');
  const state = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-player-surface-open] [data-player-backdrop="active"]')!).animationPlayState);
  await expect.poll(state).toBe('running');
  // Synthetic lifecycle events verify our policy, not native window occlusion.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-page-hidden');
  await expect.poll(state).toBe('paused');
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-page-hidden');
  await expect.poll(state).toBe('running');
});


test('reduced motion disables wallpaper drift', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMusicPlayer(page);
  const backdrop = page.locator('[data-player-surface-open] [data-player-backdrop="active"]');
  await expect.poll(() => backdrop.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});


test('hidden presentation catches up while real audio keeps advancing', async ({ page }) => {
  await openMusicPlayer(page);
  const position = () => page.evaluate(async () => {
    const path = '/player/src/stores/index.ts';
    const { state } = await import(/* @vite-ignore */ path);
    return { time: state.playback.currentTime, playing: state.playback.isPlaying };
  });
  await expect.poll(async () => (await position()).time).toBeGreaterThan(.2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Select by type as the transport label is translated by the application.
  const slider = page.locator('[data-player-stage-mode="now-playing"] input[type="range"]').first();
  const frozen = await slider.inputValue();
  const before = (await position()).time;
  await expect.poll(async () => (await position()).time).toBeGreaterThan(before + 1.2);
  expect((await position()).playing).toBe(true);
  expect(await slider.inputValue()).toBe(frozen);
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(Number(frozen));
});
