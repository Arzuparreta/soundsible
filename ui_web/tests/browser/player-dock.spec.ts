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
  const closeIcon = surface.getByRole('button', { name: 'Cerrar', exact: true }).locator('path');
  await expect(closeIcon).toHaveAttribute('d', 'm9 6 6 6-6 6');
  await surface.getByRole('button', { name: 'Pantalla completa', exact: true }).click();
  await expect(surface).not.toHaveAttribute('data-docked', '');
  await expect(closeIcon).toHaveAttribute('d', 'm6 9 6 6 6-6');
  await expect(surface.getByRole('button', { name: 'Junto a la app', exact: true }).locator('path'))
    .toHaveAttribute('d', 'M9 4v5H4m11-5v5h5M4 15h5v5m11-5h-5v5');
  await expect(page.locator('#app')).toBeHidden();
  await page.reload();
  await openMusicPlayer(page);
  await expect(surface).not.toHaveAttribute('data-docked', '');
  await surface.getByRole('button', { name: 'Junto a la app', exact: true }).click();
  await expect(surface).toHaveAttribute('data-docked', '');
  await expect(page.locator('#app')).toBeVisible();
});

test('full screen fits the cover and a double-click restores the automatic split', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  await surface.getByRole('button', { name: 'Pantalla completa', exact: true }).click();
  await expect(surface).not.toHaveAttribute('data-compact', '');
  for (const mode of ['now-playing', 'auto'] as const) {
    if (mode === 'auto') await surface.getByRole('tab', { name: 'DJ', exact: true }).click();
    const stage = surface.locator(`[data-player-stage-mode="${mode}"]`);
    const stageTile = surface.locator('[data-player-tile="stage"]:visible');
    const listTile = surface.locator(mode === 'auto' ? '[data-player-tile="route"]' : '[data-player-tile="queue"]');
    const grip = listTile.getByRole('button', { name: /^Mover panel/ });
    const cover = stage.locator('[data-player-cover-slot]');
    const splitter = surface.getByRole('separator', { name: 'Redimensionar paneles' });
    const reset = surface.getByRole('button', { name: 'Restablecer paneles', exact: true });
    await expect(cover).toBeVisible();
    await settle(page, '[data-player-surface-open]');
    const artWidth = async () => (await cover.boundingBox())!.width;
    const fitted = await artWidth();
    const room = () => stage.evaluate((element) => {
      const { paddingLeft, paddingRight } = getComputedStyle(element);
      return element.getBoundingClientRect().width - parseFloat(paddingLeft) - parseFloat(paddingRight);
    });
    expect(await room()).toBeCloseTo(fitted, 0);
    await expect(reset).toHaveCount(0);
    const centerX = async (element: typeof grip) => {
      const box = (await element.boundingBox())!;
      return box.x + box.width / 2;
    };
    expect(await centerX(grip)).toBeCloseTo(await centerX(listTile), 0);
    expect((await grip.boundingBox())!.y).toBeCloseTo(
      (await stageTile.getByRole('button', { name: /^Mover panel/ }).boundingBox())!.y, 0,
    );
    await page.screenshot({ path: info.outputPath(`fullscreen-${mode}.png`) });

    await splitter.focus();
    await page.keyboard.press('ArrowRight');
    expect(await artWidth()).toBeGreaterThanOrEqual(fitted - 3);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(artWidth).toBeLessThan(fitted - 5);

    await expect(reset).toBeVisible();
    await reset.focus();
    await expect(reset.locator('..').getByText('Restablecer paneles', { exact: true })).toBeVisible();
    if (mode === 'now-playing') await page.screenshot({ path: info.outputPath('fullscreen-reset.png') });
    await reset.click();
    await expect.poll(artWidth).toBeCloseTo(fitted, 0);
    await expect(reset).toHaveCount(0);

    await splitter.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(reset).toBeVisible();
    await splitter.dblclick();
    await expect.poll(artWidth).toBeCloseTo(fitted, 0);

    await page.setViewportSize({ width: 1558, height: 839 });
    await expect.poll(artWidth).toBeGreaterThan(fitted);
    expect(await room()).toBeCloseTo(await artWidth(), 0);
    await page.setViewportSize({ width: 1366, height: 768 });

    await grip.click();
    await expect(page.getByRole('button', { name: 'Mover a la izquierda', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Mover a la izquierda', exact: true })).toHaveCount(0);
    if (mode === 'now-playing') {
      await grip.dragTo(stageTile);
      await expect.poll(async () => (await centerX(listTile)) < (await centerX(stageTile))).toBe(true);
      await reset.click();
      await expect.poll(async () => (await centerX(listTile)) > (await centerX(stageTile))).toBe(true);
    }
  }
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
  // A width of the listener's own puts the way back beside the line, at its foot.
  const reset = page.getByRole('button', { name: 'Restablecer el ancho del reproductor', exact: true });
  await expect(reset).toBeVisible();
  const [resetBox, edgeBox] = [(await reset.boundingBox())!, (await edge.boundingBox())!];
  expect(resetBox.x - edgeBox.x).toBeLessThanOrEqual(16);
  expect(resetBox.y + resetBox.height).toBeGreaterThan(edgeBox.y + edgeBox.height - 60);
  await reset.click();
  await expect.poll(width).toBe(420);
  await expect(reset).toHaveCount(0);
  await expect(edge).toBeFocused();
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(reset).toBeVisible();
  await edge.dblclick();
  await expect.poll(width).toBe(420);
  await expect(reset).toHaveCount(0);
  await page.reload();
  await openMusicPlayer(page);
  await expect.poll(width).toBe(420);

  await edge.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(360);
  const pill = surface.getByRole('tablist', { name: 'Modo del reproductor' });
  const presentation = surface.getByRole('button', { name: 'Pantalla completa', exact: true });
  const devices = surface.locator('[data-device-trigger="player-header"]');
  const close = surface.getByRole('button', { name: 'Cerrar', exact: true });
  const [surfaceBox, pillBox, presentationBox, deviceBox, closeBox] = await Promise.all(
    [surface, pill, presentation, devices, close].map(async (element) => (await element.boundingBox())!),
  );
  expect(Math.abs(pillBox.x + pillBox.width / 2 - surfaceBox.x - surfaceBox.width / 2)).toBeLessThan(1);
  expect(pillBox.x).toBeGreaterThan(deviceBox.x + deviceBox.width);
  expect(pillBox.x + pillBox.width).toBeLessThan(presentationBox.x);
  expect(presentationBox.x + presentationBox.width).toBeLessThan(closeBox.x);
});
