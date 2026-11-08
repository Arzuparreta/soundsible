import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

// These tests own module failures and the WAV stream. A production service
// worker can satisfy imports from cache or fetch media outside page.route.
test.use({ serviceWorkers: 'block' });

async function position(page: Page) {
  return page.locator('[data-omni-player]').evaluate(element => ({
    position: Number(element.querySelector<HTMLInputElement>('[data-omni-seek] input')!.value),
    title: element.querySelector('[data-omni-meta]')?.textContent,
    playing: Boolean(element.querySelector('button[aria-label="Pausar"]')),
  }));
}

test('switching an open NORMAL player to DJ needs no UI download after a station update', async ({ page }) => {
  await mockMusicEngine(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openMusicPlayer(page);
  await expect(page.locator('[data-player-stage-mode="now-playing"]')).toBeVisible();
  await expect.poll(async () => (await position(page)).position).toBeGreaterThan(0);
  const before = await position(page);
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  // Reproduce the station's obsolete hashed chunk returning 404, but only
  // after NORMAL is open. All code needed by the mode switch must be present.
  const missing: string[] = [];
  await page.route(url => /\.(?:tsx?|js|css)$/.test(url.pathname), async route => {
    // Optional telemetry is loaded by entering a DJ session, not its UI.
    if (route.request().url().includes('/djEvidenceRecorder')) return route.continue();
    missing.push(route.request().url());
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Obsolete UI module' });
  });
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  await expect(page.locator('#now-playing-view')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#auto-mode-view [data-player-stage-mode="auto"]')).toBeVisible();
  await expect.poll(async () => (await position(page)).position).toBeGreaterThan(before.position);
  expect(await position(page)).toMatchObject({ title: before.title, playing: true });
  await page.getByRole('tab', { name: 'NORMAL', exact: true }).click();
  await expect(page.locator('[data-player-stage-mode="now-playing"]')).toBeVisible();
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  await expect(page.locator('#auto-mode-view [data-player-stage-mode="auto"]')).toBeVisible();
  expect({ missing, errors, navigations }).toEqual({ missing: [], errors: [], navigations: 0 });
});

test('a failed first DJ UI load offers recovery while the current song keeps playing', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await expect.poll(async () => (await position(page)).position).toBeGreaterThan(0);
  const before = await position(page);
  const view = /\/(?:playerViews|AutoMode)(?:-[^/]+)?\.(?:js|ts|tsx)(?:\?|$)/;
  let failures = 0;
  await page.route(view, route => {
    failures++;
    return route.fulfill({ status: 503, body: 'temporary UI failure' });
  });
  // The chrome remains usable even if the first shared view load fails.
  await page.getByRole('button', { name: /^NORMAL:/ }).click();
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  const dj = page.locator('#auto-mode-view');
  await expect.poll(() => failures).toBeGreaterThan(0);
  await expect(dj.getByRole('button', { name: 'Reintentar', exact: true })).toBeVisible();
  await expect.poll(async () => (await position(page)).position).toBeGreaterThan(before.position);
  await page.unroute(view);
  await dj.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await expect(dj.locator('[data-player-stage-mode="auto"]')).toBeVisible();
  expect(await position(page)).toMatchObject({ title: before.title, playing: true });
});
