import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

test.use({ reducedMotion: 'no-preference' });

// The fixture's silent WAV advances for three minutes, which is all "real
// audio keeps advancing" below needs. The MP3 fixture kills the Linux WebKit
// WebProcess when the transport pauses.
test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
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
  expect(dark.timing).toMatch(/^steps\(76(?:, end)?\)$/);
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


// Every frame in which anything on the open stage changes makes the compositor
// redo the glass over the wallpaper, so the stage's moving parts are budgeted
// in frames, not just in pixels.
test('the open stage\'s glass tints the wallpaper without blurring it again', async ({ page }) => {
  await openMusicPlayer(page);
  const glass = () => page.evaluate(() => [...document.querySelectorAll('[data-player-surface-open] [data-player-tile]')]
    .map((tile) => { const css = getComputedStyle(tile); return css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'); }));
  await expect.poll(async () => (await glass()).length).toBeGreaterThan(0);
  for (const filter of await glass()) expect(filter).toMatch(/^saturate\(/);
});

test('the queue equaliser moves all its bars on the same few frames a second', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the queue is on screen with the stage only on desktop');
  await openMusicPlayer(page);
  const bars = () => page.evaluate(() => document.getAnimations()
    .filter((animation) => animation instanceof CSSAnimation && animation.animationName.includes('playerTrackEq')).length);
  await expect.poll(bars).toBe(3);
  // Walk one second of the animation and count the instants at which any bar
  // changes: at 60 fps that is every frame, here once per 60 ms step with all
  // three bars together. The samples fall between step boundaries, the way
  // display frames do.
  const { looks, changes } = await page.evaluate(() => {
    const animations = document.getAnimations()
      .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.animationName.includes('playerTrackEq'));
    const targets = animations.map((animation) => (animation.effect as KeyframeEffect).target as Element);
    for (const animation of animations) animation.pause();
    const seen = new Set<string>();
    let previous = '';
    let changes = 0;
    for (let time = 1001; time < 2001; time += 4) {
      for (const animation of animations) animation.currentTime = time;
      const now = targets.map((bar) => getComputedStyle(bar).transform).join('|');
      if (previous && now !== previous) changes += 1;
      previous = now;
      seen.add(now);
    }
    return { looks: seen.size, changes };
  });
  expect(looks).toBeGreaterThan(10);
  expect(changes).toBeLessThanOrEqual(20);
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
