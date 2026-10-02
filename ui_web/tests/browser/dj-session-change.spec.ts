import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer, TRACKS } from './music-browser-fixture';

async function showRoute(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe] button').nth(2).click();
  }
  return page.locator('[data-auto-tile="route"]');
}

function plan(request: { seed?: { id: string }; direction_revision?: number }, cold: boolean) {
  return {
    v: 6, plan_id: 'session-plan', intent: 'auto_mode', profile: 'balanced',
    seed_identity: request.seed?.id, direction_revision: request.direction_revision,
    items: cold ? [] : TRACKS.slice(0, 8).map(row => ({
      ...row, source_pool: 'local', recommendation_identity: `music:track:${row.id}`,
    })),
    warming: cold, degraded: cold, retry_after: cold ? 2 : null,
    empty_reason: cold ? 'temporary_failure' : null,
    pool_counts: { local: cold ? 0 : 8, related: 0, discovery: 0 }, generated_at: 1,
  };
}

for (const language of ['es', 'en'] as const) {
  test(`Session actions fill their row and recovers a cold current-song change automatically (${language})`, async ({ page }) => {
    await mockMusicEngine(page);
    await page.addInitScript(lang => localStorage.setItem('lang', lang), language);
    let attempts = 0;
    const references: string[] = [];
    await page.route('**/api/discovery/music/dj-plan', async route => {
      attempts += 1;
      const request = route.request().postDataJSON();
      references.push(request.sources[0].tracks[0].id);
      await route.fulfill({ json: plan(request, attempts === 2 || attempts === 3) });
    });
    await page.goto('/player/#/library?view=songs');
    await page.getByRole('button', { name: /(?:Reproducir|Play) Canción de biblioteca 320/ }).click();
    await openMiniPlayer(page, /^NORMAL:/);
    await page.getByRole('tab', { name: 'DJ', exact: true }).click();
    const route = await showRoute(page);
    await expect(route.locator('[data-drag-row]').first()).toBeVisible();
    const session = route.getByRole('region', { name: language === 'es' ? 'Sesión' : 'Session' });
    const header = session.locator('header');
    await expect(header.getByRole('button')).toHaveCount(3);
    // No title: the three actions span the row, side by side.
    const geometry = await header.evaluate(element => {
      const header = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return { left: header.left, right: header.right, buttons: buttons.map(b => ({ x: b.x, y: b.y, right: b.right })) };
    });
    await expect(header.locator('strong')).toHaveCount(0);
    expect(Math.abs(geometry.buttons[0].x - geometry.left)).toBeLessThan(2);
    expect(Math.abs(geometry.buttons[2].right - geometry.right)).toBeLessThan(2);
    expect(Math.max(...geometry.buttons.map(b => b.y)) - Math.min(...geometry.buttons.map(b => b.y))).toBeLessThan(2);
    // Each label reads in full and sits next to its icon, the pair centred in
    // its button. A label stretched across the spare width left its text
    // centred far from the icon it belongs to.
    const labels = await header.locator('button span').evaluateAll(elements => elements.map(label => {
      const button = label.parentElement!;
      const icon = button.querySelector('svg')!.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        width: label.clientWidth, contentWidth: label.scrollWidth, iconWidth: icon.width,
        spacing: text.left - icon.right, gap: Number.parseFloat(getComputedStyle(button).gap),
        before: icon.left - box.left, after: box.right - text.right,
      };
    }));
    for (const label of labels) {
      expect(label.contentWidth).toBeLessThanOrEqual(label.width + 1);
      expect(label.iconWidth).toBeGreaterThan(0);
      expect(Math.abs(label.spacing - label.gap)).toBeLessThan(1);
      expect(Math.abs(label.before - label.after)).toBeLessThan(2);
    }
    await header.screenshot({ path: test.info().outputPath('session-actions.png') });
    await header.getByRole('button', { name: language === 'es' ? 'Desde la actual' : 'From current', exact: true }).click();
    // The change is the source, at once: nothing is "prepared" behind the old
    // route, and the runway is planned like any refill, retries included.
    await expect(session.getByRole('status')).toHaveCount(0);
    await expect.poll(() => attempts, { timeout: 15_000 }).toBe(4);
    await expect(route.locator('[data-drag-row]').first()).toBeVisible();
    expect(references).toEqual(Array(4).fill(TRACKS[319].id));
    await expect(page.locator('[data-auto-tile="stage"]')).toContainText(TRACKS[319].title);
  });
}

test('a NORMAL song menu starts DJ from that song: it comes next, and the current song plays on', async ({ page }) => {
  await mockMusicEngine(page);
  const references: string[] = [];
  await page.route('**/api/discovery/music/dj-plan', async route => {
    const request = route.request().postDataJSON();
    references.push(request.sources[0].tracks[0].id);
    await route.fulfill({ json: plan(request, false) });
  });
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  const selected = page.locator('[data-music-list-row], [data-song-row]').filter({
    has: page.getByRole('button', { name: /Reproducir Canción de biblioteca 319/ }),
  });
  await selected.getByRole('button', { name: /Más opciones/ }).click();
  const menu = page.locator('[role="dialog"], [role="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Cambiar la sesión', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Empezar DJ desde la canción actual', exact: true })).toHaveCount(0);
  await menu.getByRole('button', { name: 'Empezar DJ desde esta canción', exact: true }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  const route = await showRoute(page);
  await expect(route.locator('[data-drag-row]').first()).toContainText(TRACKS[318].title);
  await expect(route.getByRole('region', { name: 'Sesión' })).toContainText(TRACKS[318].title);
  expect(references).toEqual([TRACKS[318].id]);
  await expect(page.locator('[data-auto-tile="stage"]')).toContainText(TRACKS[319].title);
});
