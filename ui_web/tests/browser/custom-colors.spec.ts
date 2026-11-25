import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CUSTOM_COLORS_KEY, deriveCustomColors } from '../../src/boot/customColors.js';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

const path = '/player/#/settings/appearance';
const colors = { canvas: '#fbe9f3', accent: '#e8b3bc' };

test('retired presets resolve to System on first paint and follow the OS', async ({ page }) => {
  await mockMusicEngine(page);
  await page.addInitScript(() => localStorage.setItem('theme', 'pure-black'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: 'Sistema', exact: true })).toBeChecked();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('custom colors preview live, survive reload and tint the normal and DJ player', async ({ page }, info) => {
  await mockMusicEngine(page);
  await page.route('**/api/static/cover/**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720"><defs><linearGradient id="cover"><stop stop-color="#ff4010"/><stop offset="0.5" stop-color="#c020e0"/><stop offset="1" stop-color="#0080ff"/></linearGradient></defs><rect width="720" height="720" fill="url(#cover)"/></svg>',
  }));
  await page.goto(path);
  const root = page.locator('html');
  const custom = page.getByRole('radio', { name: 'Personalizado', exact: true });
  const canvas = page.getByRole('textbox', { name: 'Fondo (HEX)' });
  const accent = page.getByRole('textbox', { name: 'Acento (HEX)' });
  await custom.check();
  await canvas.fill(colors.canvas);
  await expect(canvas).toBeFocused();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await accent.fill('bad input');
  await accent.press('Tab');
  await expect(accent).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Introduce un color hexadecimal', { exact: false })).toBeVisible();
  await accent.fill(colors.accent);
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), CUSTOM_COLORS_KEY)).toEqual(colors);
  await page.reload();
  await expect(custom).toBeChecked();
  await expect(canvas).toHaveValue(colors.canvas);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', deriveCustomColors(colors).tokens['bg-base']);
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);

  await page.evaluate(() => {
    window.soundsibleAppearance!.set({ theme: 'custom', colors: { canvas: '#203163', accent: '#83e6bc' } });
  });
  await expect(canvas).toHaveValue('#203163');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('radio', { name: 'Sistema', exact: true }).check();
  await expect(root).not.toHaveAttribute('data-custom-colors');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await custom.check();
  await expect(accent).toHaveValue('#83e6bc');
  await page.getByRole('button', { name: 'Restablecer colores' }).click();
  await expect(accent).toHaveValue('#78dcca');
  await page.evaluate(() => {
    window.soundsibleAppearance!.set({ theme: 'custom', colors: { canvas: '#203163', accent: '#83e6bc' } });
  });

  await page.goto('/player/#/settings/accessibility');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Grande', exact: true }).click();
  expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.getByRole('checkbox').first().uncheck();
  await openMusicPlayer(page);
  const stage = page.locator('[data-player-stage]').first();
  await expect(stage).toBeVisible();
  await expect.poll(() => stage.locator('[data-player-backdrop="active"]').evaluate(el =>
    el.hasAttribute('data-rasterized') || getComputedStyle(el).backgroundImage.includes('library-track-320'),
  )).toBe(true);
  expect(await stage.evaluate(el => getComputedStyle(el).getPropertyValue('--stage-base').trim())).toBe(deriveCustomColors({ canvas: '#203163', accent: '#83e6bc' }).tokens['bg-base']);
  expect(await stage.evaluate(el => getComputedStyle(el).getPropertyValue('--stage-wash').trim())).toContain('linear-gradient');
  await page.getByRole('tab', { name: 'DJ', exact: true }).click();
  await expect(page.locator('[data-player-stage-mode="auto"]')).toBeVisible();

  if (info.project.name.startsWith('chromium')) {
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await root.evaluate(el => getComputedStyle(el).getPropertyValue('--ink-primary').trim())).toBe('CanvasText');
    expect(await stage.evaluate(el => getComputedStyle(el).getPropertyValue('--stage-backdrop-opacity').trim())).toBe('0');
    await page.emulateMedia({ forcedColors: 'none' });
  }

});

test('a color publication in another tab repaints an open player without a reload', async ({ page, context }) => {
  await mockMusicEngine(page);
  await page.goto(path);
  await expect(page.getByRole('radio', { name: 'Sistema', exact: true })).toBeVisible();
  const other = await context.newPage();
  await mockMusicEngine(other);
  await other.goto(path);
  await expect(other.getByRole('radio', { name: 'Sistema', exact: true })).toBeVisible();
  await other.evaluate(value => window.soundsibleAppearance!.set({ theme: 'custom', colors: value }), colors);
  await expect(page.locator('html')).toHaveAttribute('data-custom-colors', '');
  await expect(page.getByRole('textbox', { name: 'Fondo (HEX)' })).toHaveValue(colors.canvas);
  await other.close();
});
