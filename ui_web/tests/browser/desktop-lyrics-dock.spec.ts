import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

// The desktop lyrics view folds the player into a dock under the lyrics. The
// stage tile is resizable, so the dock has to hold at every width the splitter
// allows: nothing overlapping, nothing outside the stage, volume still reachable.

const LRC = Array.from({ length: 30 }, (_, i) => `[00:${String(i * 2).padStart(2, '0')}.00]Line ${i + 1}`).join('\n');

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  expect(found, await locator.evaluate((element) => element.outerHTML.slice(0, 80))).not.toBeNull();
  return found!;
}

async function expectDockHolds(page: Page, stage: Locator, label: string) {
  await expect(stage).toHaveAttribute('data-lyrics-stage', '');
  // The morph runs 420ms; measure the layout it lands on.
  await expect.poll(() => stage.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
  const body = await box(stage);
  const parts: Record<string, Box> = {
    seek: await box(stage.getByRole('slider', { name: 'Buscar en la pista' })),
    info: await box(stage.locator('h1')),
    previous: await box(stage.getByRole('button', { name: 'Anterior' })),
    play: await box(stage.getByRole('button', { name: /^(Pausar|Reproducir)$/ })),
    next: await box(stage.getByRole('button', { name: 'Siguiente' })),
    mute: await box(stage.getByRole('button', { name: 'Silenciar' })),
    more: await box(stage.getByRole('button', { name: 'Más opciones', exact: true })),
  };
  const names = Object.keys(parts);
  for (const name of names) expect(inside(parts[name], body), `${label}: ${name} inside the stage`).toBe(true);
  for (const [i, a] of names.entries()) {
    for (const b of names.slice(i + 1)) expect(overlaps(parts[a], parts[b]), `${label}: ${a} clear of ${b}`).toBe(false);
  }
  const volume = stage.getByRole('slider', { name: 'Volumen' });
  await stage.getByRole('button', { name: 'Silenciar' }).hover();
  await expect(volume).toBeVisible();
  const slider = await box(volume);
  expect(inside(slider, body), `${label}: volume inside the stage`).toBe(true);
  for (const name of ['mute', 'more', 'play', 'next']) {
    expect(overlaps(slider, parts[name]), `${label}: volume clear of ${name}`).toBe(false);
  }
  await page.mouse.move(1, 1);
}

async function resizeStage(page: Page, key: 'ArrowLeft' | 'ArrowRight', presses: number) {
  const splitter = page.getByRole('separator', { name: 'Redimensionar paneles' }).first();
  await splitter.focus();
  for (let i = 0; i < presses; i++) await page.keyboard.press(key);
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('mobile'), 'the lyrics dock is the desktop stage');
  await mockMusicEngine(page);
  await page.route('**/lyrics**', (route) => route.fulfill({ json: {
    status: 'ready', synced: LRC, plain: null, instrumental: false, cached: true,
  } }));
  await page.route('**/api/discovery/music/dj-plan', async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({ json: {
      v: 6, plan_id: 'dock', intent: 'auto_mode', profile: 'balanced',
      seed_identity: request.seed?.id, direction_revision: request.direction_revision,
      items: TRACKS.slice(0, 8).map((row) => ({
        ...row, track_id: row.id, source: 'library', source_pool: 'local', recommendation_identity: `music:track:${row.id}`,
        transition: { technique: 'fade', confidence: 0.18, out_cue: 165, overlap_seconds: 8 },
      })),
      pool_counts: { local: 8, related: 0, discovery: 0 }, generated_at: 1,
    } });
  });
});

for (const mode of ['now-playing', 'auto'] as const) {
  test(`the ${mode} lyrics dock holds at every stage width`, async ({ page }) => {
    await openMusicPlayer(page);
    if (mode === 'auto') {
      await page.evaluate(async () => {
        const modulePath = '/player/src/stores/index.ts';
        const { actions } = await import(/* @vite-ignore */ modulePath);
        actions.enterAutoMode();
      });
    }
    const stage = page.locator(`[data-player-stage-mode="${mode}"]`);
    await stage.getByRole('button', { name: 'Mostrar letra' }).click();
    await expectDockHolds(page, stage, 'default');
    // Stage squeezed to its minimum, then stretched as far as it goes.
    await resizeStage(page, 'ArrowRight', 30);
    await expectDockHolds(page, stage, 'narrowest');
    await resizeStage(page, 'ArrowLeft', 60);
    await expectDockHolds(page, stage, 'widest');
  });
}
