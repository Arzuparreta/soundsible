import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';
import { settle } from './settle';

// Two rows change with the song. Beside the title: the heart appears once it is
// saved, the save/download slot disappears once it has a file. Under the
// transport: lyrics, the queue toggle on compact layouts, radio, volume, more.
// Whatever the combination, the buttons each row is left with must sit evenly —
// a control that renders nothing must not leave a box behind, or the row gets
// a double gap beside it.

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

/** Every box a row lays out, looking through layout-transparent wrappers. */
async function rowItems(page: Page, row: 'actions' | 'song') {
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  const more = stage.getByRole('button', { name: 'Más opciones', exact: true });
  await expect(more).toBeVisible();
  return stage.evaluate((root, which) => {
    const more = [...root.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Más opciones')!;
    const container = which === 'actions' ? more.parentElement! : root.querySelector('h1')!.parentElement!.nextElementSibling!;
    const items: { label: string; left: number; right: number; width: number }[] = [];
    const collect = (element: Element) => {
      const display = getComputedStyle(element).display;
      if (display === 'none') return;
      if (display === 'contents') {
        for (const child of element.children) collect(child);
        return;
      }
      const rect = element.getBoundingClientRect();
      const labelled = [...element.querySelectorAll('[aria-label]')]
        .find((child) => child.getClientRects().length > 0);
      const label = element.getAttribute('aria-label') ?? labelled?.getAttribute('aria-label') ?? element.tagName;
      items.push({ label, left: rect.left, right: rect.right, width: rect.width });
    };
    for (const child of container.children) collect(child);
    return items;
  }, row);
}

async function expectEvenRow(page: Page, row: 'actions' | 'song', expected: RegExp[], absent: RegExp[] = []) {
  // Let any entrance motion settle before measuring.
  await expect.poll(() => page.evaluate(() =>
    document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
  const items = await rowItems(page, row);
  const labels = items.map((item) => item.label);
  for (const item of items) expect(item.width, `${item.label} has a box with nothing in it`).toBeGreaterThan(0);
  for (const pattern of expected) expect(labels.some((label) => pattern.test(label)), `${pattern} in ${labels.join(' · ')}`).toBe(true);
  for (const pattern of absent) expect(labels.some((label) => pattern.test(label)), `${pattern} not in ${labels.join(' · ')}`).toBe(false);
  if (items.length < 3) return;
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

test('a downloaded song leaves no gap where the download button was', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  await expectEvenRow(page, 'actions', [/letra/i, /radio/i, isMobile ? /Silenciar/ : /Volumen/, /Más opciones/]);
  await expectEvenRow(page, 'song', [/favoritos/i], [/^(Guardar|Descargar)/]);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await expect(stage.getByRole('button', { name: /^(Guardar|Descargar)/ })).toHaveCount(0);
});

test('an unsaved song spaces its save button like the rest', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  await expectEvenRow(page, 'song', [/^Guardar/], [/favoritos/i]);
  await expectEvenRow(page, 'actions', [/letra/i, /radio/i, isMobile ? /Silenciar/ : /Volumen/, /Más opciones/]);
});

test('a saved song still streaming keeps heart and download side by side', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: /^Guardar/ }).click();
  await expect(stage.getByRole('button', { name: /^Descargar/ })).toBeVisible();
  await expectEvenRow(page, 'song', [/favoritos/i, /^Descargar/]);
  await expectEvenRow(page, 'actions', [/letra/i, /radio/i, isMobile ? /Silenciar/ : /Volumen/, /Más opciones/]);
});

test('compact volume floats beneath the speaker without moving the player', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the floating slider is a desktop control');
  await openMusicPlayer(page);
  await settle(page, '[data-player-surface-open]');
  const surface = page.locator('[data-player-surface-open]');
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  const volume = stage.getByRole('button', { name: 'Volumen', exact: true });
  const slider = surface.getByRole('slider', { name: 'Volumen', exact: true });
  const controls = [
    stage.locator('[data-player-cover-slot]'),
    stage.locator('h1'),
    stage.getByRole('button', { name: /^(Pausar|Reproducir)$/ }),
    volume,
    stage.getByRole('button', { name: 'Más opciones', exact: true }),
    surface.locator('nav'),
  ];
  const positions = () => Promise.all(controls.map((control) => control.boundingBox()));
  const before = await positions();
  await expect(slider).toBeHidden();
  await volume.hover();
  await expect(volume).toHaveAttribute('aria-expanded', 'true');
  await expect(slider).toBeVisible();
  expect(await positions()).toEqual(before);
  const popup = surface.locator(`[id="${await volume.getAttribute('aria-controls')}"]`);
  const [popupBox, buttonBox] = await Promise.all([popup.boundingBox(), volume.boundingBox()]);
  expect(popupBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height);
  await expect(popup.getByRole('button')).toHaveCount(0);
  const pagerBox = (await surface.locator('nav').boundingBox())!;
  expect(popupBox!.x).toBeCloseTo(buttonBox!.x, 0);
  expect(popupBox!.x).toBeGreaterThanOrEqual(pagerBox.x + pagerBox.width);
  await slider.hover();
  await slider.fill('45');
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await volume.click();
  await expect(slider).toHaveAttribute('aria-valuetext', '0%');
  await volume.click();
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await slider.press('Escape');
  await expect(volume).toBeFocused();
  await expect(slider).toBeHidden();
  await expect(stage).toBeVisible();
});

test('a mobile web tap toggles mute without showing a slider', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile web control');
  await openMusicPlayer(page);
  const surface = page.locator('[data-player-surface-open]');
  await surface.getByRole('button', { name: 'Silenciar', exact: true }).tap();
  await expect(surface.getByRole('slider', { name: 'Volumen', exact: true })).toHaveCount(0);
  await surface.getByRole('button', { name: 'Activar sonido', exact: true }).tap();
  await expect(surface.getByRole('button', { name: 'Silenciar', exact: true })).toBeVisible();
  await expect(surface.getByRole('slider', { name: 'Volumen', exact: true })).toHaveCount(0);
});

test('the lyrics dock spaces what it keeps of the row evenly', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('mobile'), 'the lyrics dock is the desktop stage');
  await page.route('**/api/library/tracks/*/lyrics**', (route) => route.fulfill({ json: {
    status: 'ready', synced: '[00:00.00]Una línea\n[00:04.00]Otra línea', plain: null, instrumental: false, cached: true,
  } }));
  await openMusicPlayer(page);
  await page.getByRole('button', { name: 'Pantalla completa', exact: true }).click();
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: 'Mostrar letra' }).click();
  await expect(stage).toHaveAttribute('data-lyrics-stage', '');
  await expectEvenRow(page, 'actions', [/Mostrar portada/, /Silenciar/, /Más opciones/], [/radio/i]);
  // Stretched until the dock has room for the heart beside the title.
  const splitter = page.getByRole('separator', { name: 'Redimensionar paneles' }).first();
  await splitter.focus();
  // The seam is on the stage's right, before the queue.
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight');
  await expectEvenRow(page, 'song', [/favoritos/i]);
  await expectEvenRow(page, 'actions', [/Mostrar portada/, /Silenciar/, /Más opciones/]);
});
