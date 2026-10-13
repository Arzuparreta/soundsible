import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

// The action row under the transport changes with the song: the heart appears
// once it is saved, the save/download slot disappears once it has a file, the
// queue toggle only exists on compact layouts. Whatever the combination, the
// buttons it leaves must sit evenly — a control that renders nothing must not
// leave a box behind, or the row gets a double gap beside it.

const PREVIEW = {
  id: 'preview-spacing',
  title: 'Vista previa espaciada',
  artist: 'Artista externo',
  album: 'Sencillo',
  duration: 180,
  source: 'preview' as const,
};

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

/** Every box the row lays out, looking through layout-transparent wrappers. */
async function actionRow(page: Page) {
  const more = page.locator('[data-player-stage-mode="now-playing"]').getByRole('button', { name: 'Más opciones', exact: true });
  await expect(more).toBeVisible();
  return more.evaluate((button) => {
    const items: { label: string; left: number; right: number; width: number }[] = [];
    const collect = (element: Element) => {
      const display = getComputedStyle(element).display;
      if (display === 'none') return;
      if (display === 'contents') {
        for (const child of element.children) collect(child);
        return;
      }
      const rect = element.getBoundingClientRect();
      const label = element.getAttribute('aria-label') ?? element.querySelector('[aria-label]')?.getAttribute('aria-label') ?? element.tagName;
      items.push({ label, left: rect.left, right: rect.right, width: rect.width });
    };
    for (const child of button.parentElement!.children) collect(child);
    return items;
  });
}

async function expectEvenRow(page: Page, expected: RegExp[]) {
  // Let any entrance motion settle before measuring.
  await expect.poll(() => page.evaluate(() =>
    document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
  const items = await actionRow(page);
  const labels = items.map((item) => item.label);
  for (const item of items) expect(item.width, `${item.label} has a box with nothing in it`).toBeGreaterThan(0);
  for (const pattern of expected) expect(labels.some((label) => pattern.test(label)), `${pattern} in ${labels.join(' · ')}`).toBe(true);
  const gaps = items.slice(1).map((item, i) => item.left - items[i].right);
  expect(Math.max(...gaps) - Math.min(...gaps), `gaps ${gaps.map((gap) => gap.toFixed(1)).join(', ')} between ${labels.join(' · ')}`).toBeLessThanOrEqual(1);
}

async function playPreview(page: Page) {
  await page.evaluate(async (track) => {
    const modulePath = '/player/src/stores/index.ts';
    const { actions } = await import(/* @vite-ignore */ modulePath);
    actions.playFrom([track], 0);
  }, PREVIEW);
  await expect(page.locator('[data-player-stage-mode="now-playing"] h1')).toHaveText(PREVIEW.title);
}

test('a downloaded song leaves no gap where the download button was', async ({ page }) => {
  await openMusicPlayer(page);
  await expectEvenRow(page, [/favoritos/i, /radio/i, /Silenciar/, /Más opciones/]);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await expect(stage.getByRole('button', { name: /^(Guardar|Descargar)/ })).toHaveCount(0);
});

test('an unsaved song spaces its save button like the rest', async ({ page }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  await expectEvenRow(page, [/^Guardar/, /radio/i, /Silenciar/, /Más opciones/]);
});

test('a saved song still streaming spaces heart and download evenly', async ({ page }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: /^Guardar/ }).click();
  await expect(stage.getByRole('button', { name: /^Descargar/ })).toBeVisible();
  await expectEvenRow(page, [/favoritos/i, /^Descargar/, /radio/i, /Silenciar/, /Más opciones/]);
});

test('the lyrics dock spaces what it keeps of the row evenly', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('mobile'), 'the lyrics dock is the desktop stage');
  await page.route('**/lyrics**', (route) => route.fulfill({ json: {
    status: 'ready', synced: '[00:00.00]Una línea\n[00:04.00]Otra línea', plain: null, instrumental: false, cached: true,
  } }));
  await openMusicPlayer(page);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: 'Mostrar letra' }).click();
  await expect(stage).toHaveAttribute('data-lyrics-stage', '');
  await expectEvenRow(page, [/Silenciar/, /Más opciones/]);
  // Stretched until the dock has room for the heart and the inline slider.
  const splitter = page.getByRole('separator', { name: 'Redimensionar paneles' }).first();
  await splitter.focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowLeft');
  await expectEvenRow(page, [/favoritos/i, /Silenciar/, /Más opciones/]);
});
