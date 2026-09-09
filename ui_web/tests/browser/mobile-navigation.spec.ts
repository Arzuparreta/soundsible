import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile'));
  await mockMusicEngine(page);
  await page.goto('/player/#/');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

test('compact selector, favourites persistence, and explicit local search', async ({ page }) => {
  const header = page.locator('[data-mobile-library-header]');
  await expect(header.getByRole('button', { name: 'Canciones' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mi biblioteca', exact: true })).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav.locator(':scope > *')).toHaveCount(4);
  await header.getByRole('button', { name: 'Canciones' }).click();
  const sheet = page.getByRole('dialog', { name: 'Biblioteca' });
  await expect(sheet.getByRole('button', { name: 'Canciones', exact: true })).toHaveAttribute('aria-current', 'true');
  await sheet.getByRole('button', { name: 'Álbumes', exact: true }).click();
  await expect(header.getByRole('button', { name: 'Álbumes', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Álbumes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Favoritos', exact: true }).click();
  await expect(page).toHaveURL(/#\/favourites$/);
  await expect(header.getByRole('button', { name: 'Favoritos' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Buscar', exact: true }).click();
  await nav.getByRole('link', { name: 'Biblioteca', exact: true }).click();
  await expect(header.getByRole('button', { name: 'Favoritos' })).toBeVisible();
  await header.getByRole('button', { name: 'Favoritos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Buscar en biblioteca' }).click();
  await expect(page.getByRole('textbox', { name: 'Buscar canciones y artistas' })).toBeFocused();
});

test('More closes on Back and Escape, restores focus, and navigates without a phantom history entry', async ({ page }) => {
  const more = page.getByRole('button', { name: 'Más', exact: true });
  await more.click();
  await expect(page.getByRole('dialog', { name: 'Más' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/$/);
  await expect(more).toBeFocused();
  await more.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Descargas', exact: true }).click();
  await expect(page).toHaveURL(/#\/downloads$/);
  await expect(more).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('local search can be left through the selector, and downloaded filtering stays visible and removable', async ({ page }) => {
  const header = page.locator('[data-mobile-library-header]');
  await header.getByRole('button', { name: 'Canciones', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Buscar en biblioteca' }).click();
  const search = page.getByRole('textbox', { name: 'Buscar canciones y artistas' });
  await expect(search).toBeFocused();
  await search.fill('biblioteca 320');
  await header.getByRole('button', { name: 'Canciones', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Artistas', exact: true }).click();
  await expect(search).toBeHidden();
  await expect(header.getByRole('button', { name: 'Artistas', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Artistas', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Canciones', exact: true }).click();
  await header.getByRole('button', { name: 'Ordenar biblioteca', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Descargadas', exact: true }).click();
  const filter = page.getByRole('button', { name: 'Descargadas', exact: true });
  await expect(filter).toBeVisible();
  await filter.click();
  await expect(filter).toHaveCount(0);
});

test('the view selector is marked with a drawn chevron sitting on the title axis', async ({ page }) => {
  const title = page.locator('[data-mobile-library-header] h1 button');
  const chevron = title.locator('svg');
  await expect(chevron).toHaveCount(1);
  for (const size of ['compact', 'normal', 'large']) {
    await page.evaluate((size) => document.documentElement.dataset.interfaceSize = size, size);
    const font = await title.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const box = (await chevron.boundingBox())!;
    // Half its box wide, so it stays a chevron beside the title rather than the
    // needle-thin glyph it replaced, and it tracks the interface scale.
    expect(box.width / font).toBeGreaterThan(0.45);
    expect(box.width / font).toBeLessThan(0.75);
    expect(box.height / box.width).toBeCloseTo(1, 1);
    // On the axis of the capitals, which sits a hair above the line box middle.
    const label = (await title.locator('span').boundingBox())!;
    const off = (box.y + box.height / 2) - (label.y + label.height / 2);
    expect(off).toBeLessThan(0);
    expect(Math.abs(off)).toBeLessThan(font * 0.09);
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
