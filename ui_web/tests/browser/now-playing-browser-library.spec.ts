import { expect, test } from '@playwright/test';
import { mockMusicEngine as mockEngine, openMusicPlayer as openNowPlaying } from './music-browser-fixture';

test.beforeEach(async ({ page }) => {
  await mockEngine(page);
});

test('desktop Now Playing opens Library directly on visible virtual song rows', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'desktop-only regression');
  await openNowPlaying(page);

  const browser = page.locator('[data-now-playing-tile="browser"]');
  await browser.getByRole('button', { name: /^Biblioteca/ }).click();

  await expect(browser.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
  await expect.poll(() => browser.locator('[data-virtual-rows] > div').count()).toBeGreaterThan(0);
});
