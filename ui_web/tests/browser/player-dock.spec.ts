import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';
import { settle } from './settle';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'a phone has no room beside the player');
  await mockMusicEngine(page);
});

test('the open player docks beside the app, and the app stays usable', async ({ page }) => {
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  await settle(page, '[data-player-surface-open]');
  await expect(surface).toHaveAttribute('data-docked', '');
  await expect(surface).toHaveAttribute('data-compact', '');
  const viewport = page.viewportSize()!;
  const box = (await surface.boundingBox())!;
  expect(box.x + box.width).toBeCloseTo(viewport.width, 0);
  expect(box.width).toBeLessThanOrEqual(viewport.width / 2);
  // The app gives the column its room: nothing of it sits under the player.
  const content = (await page.locator('#app [data-primary-scroll]:visible').first().boundingBox())!;
  expect(content.x + content.width).toBeLessThanOrEqual(box.x + 1);
  // The bottom player bar steps aside; the column has the same controls.
  await expect(page.locator('[data-omni-player]')).toBeHidden();
  // The app answers while the player is open: a song played from it plays.
  await page.locator('#app').getByRole('button', { name: /Reproducir Canción de biblioteca 319/ }).click();
  await expect(page.locator('#now-playing-view [data-player-tile="stage"]')).toContainText('Canción de biblioteca 319');
  await expect(surface).toBeVisible();
});

test('the player fills the screen or docks again, and remembers it', async ({ page }) => {
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  await surface.getByRole('button', { name: 'Pantalla completa', exact: true }).click();
  await expect(surface).not.toHaveAttribute('data-docked', '');
  await expect(page.locator('#app')).toBeHidden();
  await page.reload();
  await openMusicPlayer(page);
  await expect(surface).not.toHaveAttribute('data-docked', '');
  await surface.getByRole('button', { name: 'Junto a la app', exact: true }).click();
  await expect(surface).toHaveAttribute('data-docked', '');
  await expect(page.locator('#app')).toBeVisible();
});

test('the column is resized from its edge, by pointer or keyboard, within its bounds', async ({ page }) => {
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  await settle(page, '[data-player-surface-open]');
  const edge = page.getByRole('separator', { name: 'Cambiar el ancho del reproductor' });
  const width = async () => Math.round((await surface.boundingBox())!.width);
  const start = await width();
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(start + 24);
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(start);

  const handle = (await edge.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  // Within a pixel: the pointer was pressed somewhere inside the edge.
  await expect.poll(async () => Math.abs((await width()) - (start + 80))).toBeLessThanOrEqual(1);
  // Never wider than half the window, never narrower than its controls.
  await page.mouse.move(handle.x - 80, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBeLessThanOrEqual(Math.floor(page.viewportSize()!.width / 2));
  await edge.dblclick();
  await expect.poll(width).toBe(420);
  await page.reload();
  await openMusicPlayer(page);
  await expect.poll(width).toBe(420);
});
