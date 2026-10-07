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
  await page.getByRole('button', { name: 'Mostrar letra' }).first().click();
  const panel = page.locator('[data-lyrics-scroll]').first();
  await expect(panel.getByRole('button', { name: 'Line 1', exact: true })).toBeVisible();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

test('lyrics timed for another cut ask for a tap, then follow it', async ({ page }) => {
  const saved = await mockLyrics(page, { timing_safe: false, synced_duration: 236 });
  const panel = await showLyrics(page);

  const notice = panel.locator('[data-lyrics-timing]');
  await expect(notice).toContainText('Puede que esta letra esté sincronizada para otra versión');
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Ajustar sincronía' })).toHaveCount(0);

  // The notice stays readable over the lines, inside the panel.
  const noticeBox = (await notice.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(noticeBox.x).toBeGreaterThanOrEqual(panelBox.x - 0.5);
  expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);

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

  await expect(panel.locator('[data-lyrics-timing]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ajustar sincronía' }).click();
  const notice = panel.locator('[data-lyrics-timing]');
  await expect(notice).toContainText('Toca el verso que está sonando ahora');

  await notice.getByRole('button', { name: 'Restablecer sincronía' }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect((saved[0] as { offset_ms: unknown }).offset_ms).toBeNull();
  await expect(notice).toHaveCount(0);
});
