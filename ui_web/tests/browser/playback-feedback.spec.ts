import { expect, test, type Locator } from '@playwright/test';
import { mockMusicEngine, silentWav } from './music-browser-fixture';

// The fixture's silent WAV is the audio here on purpose. These tests are about
// the transport and the queue, not about a format, and the MP3 fixture kills
// the Linux WebKit WebProcess the moment the transport pauses.
test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

test('a large queue remains bounded and transport updates preserve its rows in the pill, NORMAL and DJ', async ({ page }) => {
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  // Named by what it does. Keyed off `aria-busy` the locator described a state
  // rather than a control, so it stopped matching the moment the state changed
  // and the next click waited out the whole test budget.
  const pill = page.locator('[data-omni-player]')
    .getByRole('button', { name: /^(Pausar|Reproducir|Cancelar|Reintentar)$/ });
  await expect(pill).toHaveAttribute('aria-label', 'Pausar');
  const rows = page.locator('[data-now-playing-tile="queue"] [data-drag-row]');
  await expect(rows.first()).toBeAttached();
  // The queue contains the whole library, but only its viewport is mounted.
  expect(await rows.count()).toBeLessThan(60);

  const toggle = async (button: Locator, label: string) => {
    const before = await rows.first().elementHandle();
    await button.click();
    await expect(button).toHaveAttribute('aria-label', label);
    expect(await before!.evaluate(node => node.isConnected)).toBe(true);
    await before!.dispose();
  };
  await toggle(pill, 'Reproducir');
  await toggle(pill, 'Pausar');
  await page.getByRole('button', { name: /^NORMAL:/ }).click();
  const stageButton = (mode: string) => page.locator(`[data-player-stage-mode="${mode}"]`)
    .getByRole('button', { name: /^(Pausar|Reproducir)$/ });
  await toggle(stageButton('now-playing'), 'Reproducir');
  await toggle(stageButton('now-playing'), 'Pausar');
  await page.getByRole('tab', { name: 'DJ' }).click();
  await expect(stageButton('auto')).toHaveAttribute('aria-label', 'Pausar');
  await toggle(stageButton('auto'), 'Reproducir');
  await toggle(stageButton('auto'), 'Pausar');
});

test('touch selection uses the orange treatment before audio loads and scrolling cancels the press', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/static/stream/**', async route => {
    await held;
    await route.fulfill({ contentType: 'audio/wav', body: silentWav });
  });
  try {
    await page.goto('/player/#/');
    const row = page.locator('[data-music-list-row]').first();
    const main = row.locator('[data-row-main]');
    const pointer = { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 40, clientY: 100 };
    await main.dispatchEvent('pointerdown', pointer);
    await expect(row).toHaveAttribute('data-playback-selected', '');
    const pressed = await row.evaluate(node => getComputedStyle(node).backgroundColor);
    await main.dispatchEvent('pointermove', { ...pointer, clientY: 150 });
    await expect(row).not.toHaveAttribute('data-playback-selected');
    await main.dispatchEvent('pointercancel', pointer);
    await expect(row).not.toHaveAttribute('data-now-playing');
    await main.tap();
    await expect(row).toHaveAttribute('data-now-playing', '');
    expect(await row.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(pressed);
    await expect(page.locator('[data-omni-player] button[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  } finally {
    release();
  }
});
