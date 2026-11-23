import { expect, type Page } from '@playwright/test';

/**
 * Show one of the open player's panels the way the listener does. A compact
 * player — a phone, or the column docked beside the app on a desktop — shows
 * one panel at a time behind a pager: the stage first, then its list (the
 * queue, or the DJ route). A full-screen desktop player shows both at once.
 */
export async function showPlayerPanel(page: Page, panel: 'stage' | 'queue' | 'route'): Promise<void> {
  const surface = page.locator('[data-player-surface-open]');
  await expect(surface).toBeVisible();
  const auto = panel === 'route' || (panel === 'stage' && await page.evaluate(() => document.documentElement.dataset.playerSurface === 'auto'));
  const tile = page.locator(auto ? `[data-auto-tile="${panel}"]` : `[data-now-playing-tile="${panel}"]`);
  if (await surface.evaluate((element) => element.getBoundingClientRect().width < 1024)) {
    await surface.locator('nav[data-no-surface-swipe] button').nth(panel === 'stage' ? 0 : 1).click();
    // Settled where the pager put it, not on its way there: a row measured
    // mid-scroll is somewhere else by the time the pointer gets to it.
    await expect.poll(() => tile.evaluate((element) => {
      const carousel = element.closest('[data-now-playing-carousel], [data-auto-carousel]');
      return carousel ? Math.abs(element.getBoundingClientRect().left - carousel.getBoundingClientRect().left) : 0;
    })).toBeLessThan(2);
  }
  await expect(tile).not.toHaveAttribute('inert', '');
}

/** Open the player full screen from the start, for the specs about the wide
 * stage-and-list workspace rather than the column docked beside the app. */
export async function fullScreenPlayer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('player:presentation:v1', 'full'); } catch { /* storage unavailable */ }
  });
}
