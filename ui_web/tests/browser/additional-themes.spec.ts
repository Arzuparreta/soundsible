import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { EXTRA_THEMES } from '../../src/boot/themes';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

/* What the theme picker calls each palette. Keyed on the shared list, so a
   palette added to it does not compile until this walk knows its name. */
const LABELS: Record<(typeof EXTRA_THEMES)[number], string> = {
  slate: 'Pizarra',
  'pure-black': 'Negro puro',
  'forest-green': 'Verde bosque',
};

/* The shared list, so a palette cannot ship without being walked end to end. */
for (const theme of EXTRA_THEMES) {
  test(`${theme}: selection, persistence, accessibility and player`, async ({ page }, info) => {
    await mockMusicEngine(page);
    await page.route('**/api/static/cover/**', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720"><defs><linearGradient id="cover"><stop stop-color="#ff4010"/><stop offset="0.5" stop-color="#c020e0"/><stop offset="1" stop-color="#0080ff"/></linearGradient></defs><rect width="720" height="720" fill="url(#cover)"/></svg>',
    }));
    await page.goto('/player/#/settings/appearance');
    const option = page.getByRole('radio', { name: LABELS[theme], exact: true });
    await option.check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('radio', { name: 'Oscuro', exact: true })).not.toBeChecked();
    await expect(page.locator('details')).toHaveCount(0);
    await page.reload();
    await expect(option).toBeChecked();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#startup-screen')).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`${theme}.png`) });
    expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('radio', { name: 'Sistema', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await option.check();
    await page.goto('/player/#/settings/accessibility');
    const disclosure = page.locator('details');
    await expect(disclosure).not.toHaveAttribute('open');
    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open');
    await expect(page.locator('#bottom-position-0')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#bottom-position-0')).toBeHidden();
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Grande', exact: true }).click();
    expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('checkbox').first().uncheck();
    await openMusicPlayer(page);
    await expect(page.locator('[data-player-stage]').first()).toBeVisible();
    await expect.poll(() => page.locator('[data-player-surface-open]').evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`${theme}-player.png`) });
    await page.getByRole('tab', { name: 'DJ', exact: true }).click();
    await expect(page.locator('[data-player-stage-mode="auto"]')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`${theme}-dj.png`) });
    if (theme === 'pure-black') {
      expect(await page.locator('[data-player-stage]').first().evaluate(el => getComputedStyle(el).getPropertyValue('--stage-backdrop-opacity').trim())).toBe('0');
    }
    if (info.project.name.startsWith('chromium')) {
      await page.emulateMedia({ forcedColors: 'active' });
      expect(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--ink-primary').trim())).toBe('CanvasText');
    }
  });
}
