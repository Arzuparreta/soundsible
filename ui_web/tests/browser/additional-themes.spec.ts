import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

for (const theme of ['slate', 'pure-black']) {
  test(`${theme}: selection, persistence, accessibility and player`, async ({ page }, info) => {
    await mockMusicEngine(page);
    const bytes = Buffer.from(readFileSync(new URL('./fixtures/progressive-preview.mp3.b64', import.meta.url), 'utf8'), 'base64');
    await page.route('**/api/static/stream/**', route => route.fulfill({ contentType: 'audio/mpeg', body: bytes }));
    await page.route('**/api/static/cover/**', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720"><defs><linearGradient id="cover"><stop stop-color="#ff4010"/><stop offset="0.5" stop-color="#c020e0"/><stop offset="1" stop-color="#0080ff"/></linearGradient></defs><rect width="720" height="720" fill="url(#cover)"/></svg>',
    }));
    await page.goto('/player/#/settings/appearance');
    const select = page.getByRole('combobox', { name: 'Otros temas' });
    await select.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('button', { name: 'Oscuro', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('details')).toHaveCount(0);
    await page.reload();
    await expect(select).toHaveValue(theme);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#startup-screen')).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: `test-results/${theme}-${info.project.name}.png` });
    expect((await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'Sistema', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await select.selectOption(theme);
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
    await page.screenshot({ animations: 'disabled', path: `test-results/${theme}-player-${info.project.name}.png` });
    await page.getByRole('tab', { name: 'DJ', exact: true }).click();
    await expect(page.locator('[data-player-stage-mode="auto"]')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: `test-results/${theme}-dj-${info.project.name}.png` });
    if (theme === 'pure-black') {
      expect(await page.locator('[data-player-stage]').first().evaluate(el => getComputedStyle(el).getPropertyValue('--stage-backdrop-opacity').trim())).toBe('0');
    }
    if (info.project.name.startsWith('chromium')) {
      await page.emulateMedia({ forcedColors: 'active' });
      expect(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--ink-primary').trim())).toBe('CanvasText');
    }
  });
}
