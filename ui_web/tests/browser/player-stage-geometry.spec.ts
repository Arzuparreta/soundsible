import { expect, test, type Page } from '@playwright/test';
import { settle } from './settle';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

// The stage is a size container: its artwork follows both of the tile's sides
// and gives way first. Whatever the tile leaves, every control on it has to sit
// inside the tile and be the thing a press at its centre reaches — not clipped
// under the tile's edge, not under a neighbour that ran over it.

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('mobile'), 'the resizable stage and its lyrics dock are the desktop workspace');
  await mockMusicEngine(page);
});

/** Each visible stage button whose centre a press would not reach, or that
 * the tile cuts off. Scrolled into view first when `scroll` allows it. */
async function unreachable(page: Page, scroll: boolean) {
  return page.locator('[data-player-surface-open] [data-player-tile="stage"]').evaluate((tile, scroll) => {
    const problems: string[] = [];
    for (const button of tile.querySelectorAll<HTMLButtonElement>('[data-player-stage-mode] button')) {
      const css = getComputedStyle(button);
      if (css.visibility === 'hidden' || button.getClientRects().length === 0) continue;
      if (button.closest('[style*="opacity: 0"]')) continue;
      if (scroll) button.scrollIntoView({ block: 'nearest' });
      const box = tile.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const label = button.getAttribute('aria-label') ?? button.textContent ?? 'button';
      if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < box.left - 1 || rect.right > box.right + 1) {
        problems.push(`${label}: outside the tile`);
        continue;
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit?.closest('button') !== button) problems.push(`${label}: covered by ${hit?.closest('button')?.getAttribute('aria-label') ?? hit?.tagName}`);
    }
    return problems;
  }, scroll);
}

test('a short window keeps every stage control inside the tile and reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 400 });
  await openMusicPlayer(page);
  await settle(page, '[data-player-surface-open]');
  expect(await unreachable(page, false)).toEqual([]);
});

test('at the large interface size a short window scrolls the stage rather than clipping it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('soundsible:interface-size', 'large'));
  await page.setViewportSize({ width: 1280, height: 420 });
  await openMusicPlayer(page);
  await settle(page, '[data-player-surface-open]');
  expect(await unreachable(page, true)).toEqual([]);
});

test('the lyrics dock at the narrowest stage keeps its actions off the transport', async ({ page }) => {
  await page.route('**/api/library/tracks/*/lyrics**', (route) => route.fulfill({ json: {
    status: 'ready', synced: '[00:00.00]Una línea\n[00:04.00]Otra línea', plain: null, instrumental: false, cached: true,
  } }));
  await openMusicPlayer(page);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: 'Mostrar letra' }).click();
  await expect(stage).toHaveAttribute('data-lyrics-stage', '');
  // The seam between the browser and the stage, pushed right until the stage
  // stops at its minimum width.
  const splitter = page.getByRole('separator', { name: 'Redimensionar paneles' }).first();
  await splitter.focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight');
  await settle(page, '[data-player-surface-open]');
  const width = await page.locator('[data-player-surface-open] [data-player-tile="stage"]').evaluate((tile) => tile.clientWidth);
  expect(width).toBeLessThan(360);
  expect(await unreachable(page, false)).toEqual([]);
  // And the dock at full width, where everything shares one row.
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowLeft');
  await settle(page, '[data-player-surface-open]');
  expect(await unreachable(page, false)).toEqual([]);
});
