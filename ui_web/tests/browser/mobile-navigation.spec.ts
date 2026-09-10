import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await mockMusicEngine(page);
  await page.goto('/player/#/');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

test('complete menu and independent favourites', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav.locator(':scope > *')).toHaveCount(4);
  await page.getByRole('button', { name: 'Menú', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Menú' });
  await expect(panel.getByRole('link')).toHaveCount(11);
  await page.screenshot({ animations: 'disabled', path: 'test-results/navigation-drawer.png' });
  await panel.getByRole('link', { name: 'Álbumes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Álbumes', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Favoritos' }).click();
  await expect(nav.getByRole('link', { name: 'Favoritos' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Biblioteca' }).click();
  await expect(page.getByRole('heading', { name: 'Canciones', exact: true })).toBeVisible();
});

test('drawer closes on Back and Escape and restores focus', async ({ page }) => {
  const menu = page.getByRole('button', { name: 'Menú', exact: true });
  await menu.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('dialog').getByRole('link', { name: 'Descargas', exact: true }).click();
  await expect(page).toHaveURL(/#\/downloads$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('custom bar persists and settings remain accessible after removal', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await nav.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: /Apariencia/ }).click();
  await expect(page.getByLabel('Posición 2')).toHaveValue('/search');
  await page.getByLabel('Posición 4').selectOption('/live');
  await expect(page.getByLabel('Posición 4')).toHaveValue('/live');
  await page.getByRole('button', { name: 'Añadir destino' }).click();
  await expect(nav.getByRole('link')).toHaveCount(5);
  await page.screenshot({ animations: 'disabled', path: 'test-results/navigation-editor.png' });
  await page.reload();
  await expect(nav.getByRole('link')).toHaveCount(5);
  await nav.getByRole('link', { name: 'Biblioteca' }).click();
  await page.getByRole('button', { name: 'Menú', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Ajustes' }).click();
  await page.getByRole('button', { name: /Apariencia/ }).click();
  await page.getByRole('button', { name: 'Restablecer predeterminados' }).click();
  await expect(nav.getByRole('link')).toHaveCount(4);
  await expect(nav.getByRole('link', { name: 'Ajustes' })).toBeVisible();
});

test('local search and view switching keep filters usable', async ({ page }) => {
  const header = page.locator('[data-mobile-library-header]');
  await header.getByRole('button', { name: 'Buscar en biblioteca' }).click();
  const search = page.getByRole('textbox', { name: 'Buscar canciones y artistas' });
  await expect(search).toBeFocused();
  await search.fill('biblioteca 320');
  await header.getByRole('button', { name: 'Menú' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Artistas', exact: true }).click();
  await expect(search).toBeHidden();
  await header.getByRole('button', { name: 'Menú' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Canciones', exact: true }).click();
  await header.getByRole('button', { name: 'Ordenar biblioteca' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Descargadas', exact: true }).click();
  const filter = page.getByRole('button', { name: 'Descargadas', exact: true });
  await expect(filter).toBeVisible();
  await filter.click();
  await expect(filter).toHaveCount(0);
});

test('drawer traps focus and yields to desktop navigation on resize', async ({ page }) => {
  await page.getByRole('button', { name: 'Menú', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Menú' });
  await expect(panel.getByRole('button', { name: 'Cerrar', exact: true })).toBeFocused();
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
  await page.keyboard.press('Shift+Tab');
  await expect(panel.getByRole('link', { name: 'Ajustes', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(panel).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
  await expect(page.locator('aside').getByRole('link', { name: 'Ajustes', exact: true })).toBeVisible();
});

test('five custom destinations fit a narrow viewport and preserve order', async ({ page }) => {
  await page.getByRole('link', { name: 'Ajustes', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Apariencia/ }).click();
  await page.getByRole('button', { name: 'Añadir destino' }).click();
  await page.getByLabel('Posición 1').selectOption('/settings');
  await expect(page.getByLabel('Posición 4')).toHaveValue('/');
  await page.setViewportSize({ width: 320, height: 700 });
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav.getByRole('link').first()).toHaveText('Ajustes');
  await expect(nav.getByRole('link')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  for (const link of await nav.getByRole('link').all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
});

for (const width of [320, 390, 430]) {
  for (const size of ['compact', 'normal', 'large']) {
    test(`one header row and accessible controls at ${width}px, ${size}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate((size) => document.documentElement.dataset.interfaceSize = size, size);
      const header = page.locator('[data-mobile-library-header]');
      await expect(header).toBeVisible();
      const buttons = header.getByRole('button');
      const first = await buttons.first().boundingBox();
      const last = await buttons.last().boundingBox();
      expect(Math.abs(first!.y + first!.height / 2 - last!.y - last!.height / 2)).toBeLessThan(2);
      expect(first!.height).toBeGreaterThanOrEqual(43.9);
      expect(last!.x + last!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `test-results/mobile-library-${width}-${size}.png` });
    });
  }
}
