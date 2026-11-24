import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';
import { settle } from './settle';

// Two groups change with the song. Beside the title: Save/Download (hidden once
// owned), Heart (once saved), and More (⋯). On compact layouts, Lyrics, Queue,
// Radio and Volume live in the persistent bottom dock; in full screen, Lyrics,
// Radio and Volume sit in the stage actions bar. Whatever the combination,
// no hidden control may leave an empty flex slot behind.

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
async function rowItems(page: Page, row: 'actions' | 'song' | 'dock') {
  const surface = page.locator('[data-player-surface-open]');
  const stage = surface.locator('[data-player-stage-mode="now-playing"]');
  await expect(stage.getByRole('button', { name: 'Más opciones', exact: true })).toBeVisible();
  return surface.evaluate((root, which) => {
    const stageEl = root.querySelector('[data-player-stage-mode="now-playing"]')!;
    const container = which === 'dock'
      ? root.querySelector('[data-compact-dock]')!
      : which === 'actions'
        ? stageEl.querySelector('[data-stage-actions]')!
        : stageEl.querySelector('h1')!.parentElement!.nextElementSibling!;
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
    if (which === 'dock') {
      for (const group of container.children) {
        for (const child of group.children) collect(child);
      }
    } else {
      for (const child of container.children) collect(child);
    }
    return items;
  }, row);
}

async function expectEvenRow(page: Page, row: 'actions' | 'song' | 'dock', expected: RegExp[], absent: RegExp[] = []) {
  await expect.poll(() => page.evaluate(() =>
    document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
  const items = await rowItems(page, row);
  const labels = items.map((item) => item.label);
  for (const item of items) expect(item.width, `${item.label} has a box with nothing in it`).toBeGreaterThan(0);
  for (const pattern of expected) expect(labels.some((label) => pattern.test(label)), `${pattern} in ${labels.join(' · ')}`).toBe(true);
  for (const pattern of absent) expect(labels.some((label) => pattern.test(label)), `${pattern} not in ${labels.join(' · ')}`).toBe(false);
  if (row === 'dock' || items.length < 3) return;
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
  await expectEvenRow(page, 'dock', [/letra/i, /Cola/, /radio/i, isMobile ? /Silenciar/ : /Volumen/]);
  await expectEvenRow(page, 'song', [/favoritos/i, /Más opciones/], [/^(Guardar|Descargar)/]);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await expect(stage.getByRole('button', { name: /^(Guardar|Descargar)/ })).toHaveCount(0);
});

test('an unsaved song spaces its save button like the rest', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  await expectEvenRow(page, 'song', [/^Guardar/, /Más opciones/], [/favoritos/i]);
  await expectEvenRow(page, 'dock', [/letra/i, /Cola/, /radio/i, isMobile ? /Silenciar/ : /Volumen/]);
});

test('a saved song still streaming keeps heart, download and more evenly spaced', async ({ page, isMobile }) => {
  await openMusicPlayer(page);
  await playPreview(page);
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  await stage.getByRole('button', { name: /^Guardar/ }).click();
  await expect(stage.getByRole('button', { name: /^Descargar/ })).toBeVisible();
  await expectEvenRow(page, 'song', [/favoritos/i, /^Descargar/, /Más opciones/]);
  await expectEvenRow(page, 'dock', [/letra/i, /Cola/, /radio/i, isMobile ? /Silenciar/ : /Volumen/]);
});

test('compact volume floats above the bottom dock without moving the player', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the floating slider is a desktop control');
  await openMusicPlayer(page);
  await settle(page, '[data-player-surface-open]');
  const surface = page.locator('[data-player-surface-open]');
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  const dock = surface.locator('[data-compact-dock]');
  const volume = dock.getByRole('button', { name: 'Volumen', exact: true });
  const slider = surface.getByRole('slider', { name: 'Volumen', exact: true });
  const controls = [
    stage.locator('[data-player-cover-slot]'),
    stage.locator('h1'),
    stage.getByRole('button', { name: /^(Pausar|Reproducir)$/ }),
    stage.getByRole('button', { name: 'Más opciones', exact: true }),
    volume,
    dock,
  ];
  const positions = () => Promise.all(controls.map((control) => control.boundingBox()));
  const before = await positions();
  await expect(slider).toBeHidden();
  await volume.hover();
  await expect(volume).toHaveAttribute('aria-expanded', 'true');
  await expect(slider).toBeVisible();
  expect(await positions()).toEqual(before);
  const popup = surface.locator(`[id="${await volume.getAttribute('aria-controls')}"]`);
  const [popupBox, buttonBox, dockBox] = await Promise.all([popup.boundingBox(), volume.boundingBox(), dock.boundingBox()]);
  expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(buttonBox!.y);
  expect(popupBox!.x + popupBox!.width).toBeCloseTo(buttonBox!.x + buttonBox!.width, 1);
  expect(popupBox!.x).toBeGreaterThanOrEqual(dockBox!.x);
  await expect(popup.getByRole('button')).toHaveCount(0);
  await slider.hover();
  await slider.fill('45');
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await volume.click();
  await expect(slider).toHaveAttribute('aria-valuetext', '0%');
  await volume.click();
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await stage.locator('h1').click();
  await expect(slider).toBeHidden();
  await volume.hover();
  await expect(slider).toBeVisible();
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
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight');
  await expectEvenRow(page, 'song', [/favoritos/i]);
  await expectEvenRow(page, 'actions', [/Mostrar portada/, /Silenciar/, /Más opciones/]);
});
