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
  test(`Session fits its action labels and recovers a cold current-song change automatically (${language})`, async ({ page }) => {
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
    const geometry = await header.evaluate(element => {
      const header = element.getBoundingClientRect();
      const title = element.querySelector('strong')!.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return { right: header.right, titleRight: title.right, buttons: buttons.map(b => ({ x: b.x, y: b.y, right: b.right, width: b.width })) };
    });
    expect(geometry.buttons[0].x).toBeGreaterThan(geometry.titleRight);
    expect(Math.abs(geometry.buttons[2].right - geometry.right)).toBeLessThan(2);
    expect(Math.max(...geometry.buttons.map(b => b.y)) - Math.min(...geometry.buttons.map(b => b.y))).toBeLessThan(2);
    // Button widths follow their content: a short action must not reserve width
    // while a longer action truncates. Labels fill each button's available area.
    const labels = await header.locator('button span').evaluateAll(elements => elements.map(label => ({
      width: label.clientWidth, contentWidth: label.scrollWidth,
      buttonWidth: label.parentElement!.clientWidth,
      padding: Number.parseFloat(getComputedStyle(label.parentElement!).paddingLeft)
        + Number.parseFloat(getComputedStyle(label.parentElement!).paddingRight),
      iconWidth: label.parentElement!.querySelector('svg')!.getBoundingClientRect().width,
      gap: Number.parseFloat(getComputedStyle(label.parentElement!).gap),
    })));
    for (const label of labels) {
      expect(label.contentWidth).toBeLessThanOrEqual(label.width + 1);
      expect(Math.abs(label.buttonWidth - label.padding - label.iconWidth
        - (label.iconWidth ? label.gap : 0) - label.width)).toBeLessThan(2);
    }
    await header.getByRole('button', { name: language === 'es' ? 'Desde la actual' : 'From current', exact: true }).click();
    await expect(session.getByRole('status')).toContainText(language === 'es' ? 'Preparando sesión' : 'Preparing session');
    await expect(session.getByRole('button', { name: language === 'es' ? 'Cancelar' : 'Cancel', exact: true })).toBeVisible();
    await expect(session.getByRole('button', { name: language === 'es' ? 'Reintentar' : 'Retry', exact: true })).toHaveCount(0);
    await expect.poll(() => attempts, { timeout: 15_000 }).toBe(4);
    await expect(session.getByRole('status')).toHaveCount(0);
    expect(references).toEqual(Array(4).fill(TRACKS[319].id));
    await expect(page.locator('[data-auto-tile="stage"]')).toContainText(TRACKS[319].title);
  });
}

test('a NORMAL song menu starts DJ from that reference without playing the selected song', async ({ page }) => {
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
  await menu.getByRole('button', { name: 'Empezar DJ desde la canción actual', exact: true }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  const route = await showRoute(page);
  await expect(route.locator('[data-drag-row]').first()).toBeVisible();
  await expect(route.getByRole('region', { name: 'Sesión' })).toContainText(TRACKS[318].title);
  expect(references).toEqual([TRACKS[318].id]);
  await expect(page.locator('[data-auto-tile="stage"]')).toContainText(TRACKS[319].title);
});
