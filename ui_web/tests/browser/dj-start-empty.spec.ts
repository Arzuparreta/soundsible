import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

/*
 * The idle mini-player promises "Start a DJ session — Auto will choose the
 * first track". It used to open an empty DJ shell whose stage read the raw key
 * `common.nothingPlaying`, and nothing ever played.
 */
test('starting DJ with nothing playing lets the DJ choose the first song and plays it', async ({ page }) => {
  // A phone hides the idle mini-player; the affordance only exists on desktop.
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'the idle mini-player is desktop-only');
  await mockMusicEngine(page);
  const plans: Array<Record<string, any>> = [];
  await page.route('**/api/discovery/music/dj-plan', async (route) => {
    const request = route.request().postDataJSON();
    plans.push(request);
    const [opening, ...rest] = request.sources[0].tracks;
    const item = (row: { id: string; title: string; artist: string }) => ({
      ...row, track_id: row.id, source: 'library', source_pool: 'local',
      recommendation_identity: `music:track:${row.id}`,
    });
    await route.fulfill({ json: {
      v: 6, plan_id: 'opening', intent: 'auto_mode', profile: 'balanced',
      seed_identity: opening.id, direction_revision: request.direction_revision,
      opening: item(opening),
      items: rest.slice(0, 4).map(item),
      warming: false, degraded: false, retry_after: null, empty_reason: null,
      pool_counts: { local: 5, related: 0, discovery: 0 }, generated_at: 1,
      session_id: request.session_id, segment_index: 0,
    } });
  });

  await page.goto('/player/#/library?view=songs');
  await expect(page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ })).toBeVisible();
  const pill = page.locator('[data-omni-player]');
  await expect(pill).toContainText('Empezar una sesión de DJ');
  await pill.getByRole('button', { name: 'Entrar en DJ' }).click();

  const surface = page.locator('[data-player-surface-open]');
  await expect(surface).toBeVisible();
  // The first plan opens the session; later ones only top up its runway.
  await expect.poll(() => plans.length).toBeGreaterThan(0);
  expect(plans[0].seed).toBeUndefined();
  expect(plans[0].sources).toEqual([expect.objectContaining({ label: 'Biblioteca' })]);
  const opening = plans[0].sources[0].tracks[0].title as string;

  await expect(surface.locator('[data-player-stage-mode="auto"]')).toContainText(opening);
  await expect(page.getByText('common.nothingPlaying')).toHaveCount(0);
  await expect(pill.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
  expect(plans.slice(1).every((plan) => plan.seed)).toBe(true);
});
