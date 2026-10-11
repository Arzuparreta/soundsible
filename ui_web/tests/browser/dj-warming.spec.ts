import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

test('a cold DJ route warms and arrives automatically without Retry', async ({ page }) => {
  await mockMusicEngine(page);
  let attempts = 0;
  // Start the cold response after the route panel is visible, and keep the
  // ready response pending until warming is observed. Pager animation must
  // not consume the fixture's automatic two-second retry before the assertion.
  let releaseCold!: () => void;
  const coldGate = new Promise<void>(resolve => { releaseCold = resolve; });
  let releaseReady!: () => void;
  const readyGate = new Promise<void>(resolve => { releaseReady = resolve; });
  await page.route('**/api/discovery/music/dj-plan', async (route) => {
    attempts += 1;
    const cold = attempts === 1;
    const request = route.request().postDataJSON();
    await (cold ? coldGate : readyGate);
    await route.fulfill({ json: {
      v: 6, plan_id: `route-${attempts}`, intent: 'auto_mode', profile: 'balanced',
      seed_identity: request.seed?.id, direction_revision: request.direction_revision,
      items: cold ? [] : TRACKS.slice(0, 8).map((row) => ({
        ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}`,
      })),
      warming: cold, degraded: cold, retry_after: cold ? 2 : null,
      empty_reason: cold ? 'temporary_failure' : null,
      pool_counts: { local: 8, related: 0, discovery: 0 }, generated_at: 1,
    } });
  });
  await openMusicPlayer(page);
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(2).click();
  }
  const route = page.locator('[data-auto-tile="route"]');
  try {
    await expect(route).toBeVisible();
    await expect(route.locator('[data-route-loading="planning"]')).toBeVisible();
    releaseCold();
    await expect(route.locator('[data-route-loading="warming"]')).toBeVisible();
    await expect(route.getByText(/Buscando qué pega con/)).toBeVisible();
    await expect(route.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0);
  } finally {
    releaseCold();
    releaseReady();
  }
  await expect(route.locator('[data-drag-row]').first()).toBeVisible();
  await expect(route.locator('[data-route-loading]')).toHaveCount(0);
  expect(attempts).toBe(2);
});
