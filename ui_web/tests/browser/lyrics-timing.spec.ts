import { expect, test, type Page, type Route } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

// Lyrics timed for another cut of the song — a music video with an intro —
// are shown unhighlighted with a request to tap the line being sung. The tap
// becomes the recording's offset, stored by the engine, and the lines follow
// from then on.

const LRC = Array.from({ length: 30 }, (_, i) => `[00:${String(i * 2).padStart(2, '0')}.00]Line ${i + 1}`).join('\n');

async function mockLyrics(page: Page, extra: Record<string, unknown>) {
  const saved: unknown[] = [];
  await page.route('**/api/library/tracks/*/lyrics**', (route) => route.fulfill({ json: {
    status: 'ready', synced: LRC, plain: null, instrumental: false, cached: true,
    timing_safe: true, synced_duration: null, offset_ms: null, ...extra,
  } }));
  await page.route('**/api/lyrics/offset', async (route: Route) => {
    const body = route.request().postDataJSON();
    saved.push(body);
    await route.fulfill({ json: { offset_ms: body.offset_ms } });
  });
  return saved;
}

async function showLyrics(page: Page) {
  await openMusicPlayer(page);
  // A phone pages the player; the lyrics live on the stage page, reached
  // through the same pager the listener uses.
  const stage = page.locator('[data-now-playing-tile="stage"]');
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.locator('[data-player-surface-open] nav[data-no-surface-swipe]').locator('button').nth(1).click();
    await expect(stage).not.toHaveAttribute('inert', '');
  }
  await stage.getByRole('button', { name: 'Mostrar letra' }).click();
  const panel = stage.locator('[data-lyrics-scroll]').first();
  await expect(panel.getByRole('button', { name: 'Line 1', exact: true })).toBeInViewport();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

test('lyrics timed for another cut ask for a tap, then follow it', async ({ page }) => {
  const saved = await mockLyrics(page, { timing_safe: false, synced_duration: 236 });
  const panel = await showLyrics(page);

  const notice = page.locator('[data-now-playing-tile="stage"] [data-lyrics-timing]');
  await expect(notice).toContainText('Puede que esta letra esté sincronizada para otra versión');
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Ajustar sincronía' })).toHaveCount(0);

  // The notice is on screen, inside the panel, and clear of the toggle that
  // floats over the panel's corner.
  await expect(notice).toBeInViewport();
  const noticeBox = (await notice.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(noticeBox.x).toBeGreaterThanOrEqual(panelBox.x - 0.5);
  expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 0.5);
  const toggle = (await page.locator('[data-now-playing-tile="stage"]').getByRole('button', { name: 'Mostrar portada' }).boundingBox())!;
  const clear = noticeBox.x >= toggle.x + toggle.width || noticeBox.x + noticeBox.width <= toggle.x
    || noticeBox.y >= toggle.y + toggle.height || noticeBox.y + noticeBox.height <= toggle.y;
  expect(clear, 'notice clear of the cover toggle').toBe(true);

  await panel.getByRole('button', { name: 'Line 3', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  const body = saved[0] as { track_id?: string; offset_ms: number };
  expect(body.track_id).toBeTruthy();
  expect(typeof body.offset_ms).toBe('number');

  await expect(notice).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Ajustar sincronía' })).toBeVisible();
});

test('lyrics that follow can be re-aligned and reset', async ({ page }) => {
  const saved = await mockLyrics(page, { offset_ms: 4000 });
  const panel = await showLyrics(page);

  const notice = page.locator('[data-now-playing-tile="stage"] [data-lyrics-timing]');
  await expect(notice).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ajustar sincronía' }).click();
  await expect(notice).toContainText('Toca el verso que está sonando ahora');

  await notice.getByRole('button', { name: 'Restablecer sincronía' }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect((saved[0] as { offset_ms: unknown }).offset_ms).toBeNull();
  await expect(notice).toHaveCount(0);
});
