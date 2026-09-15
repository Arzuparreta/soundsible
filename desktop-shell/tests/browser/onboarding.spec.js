import { expect, test } from '@playwright/test';

import { mockTauri } from './tauri-mock.js';

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test('cancel remains recoverable and a Unicode folder enables Continue', async ({ page }) => {
  await page.goto('/');
  const choose = page.getByRole('button', { name: 'Choose folder…' });
  const proceed = page.getByRole('button', { name: 'Continue' });

  await choose.click();
  await expect(page.getByText('No folder selected')).toBeVisible();
  await expect(proceed).toBeDisabled();

  await page.evaluate(() => { window.__dialogResult = 'C:\\Users\\QA\\Música de prueba'; });
  await choose.click();
  await expect(page.getByText('C:\\Users\\QA\\Música de prueba')).toBeVisible();
  await expect(page.getByText(/12 tracks · 1.5 MB/)).toBeVisible();
  await expect(proceed).toBeEnabled();
});

test('minimum window and 200 percent zoom never create horizontal overlap', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/');
  await page.evaluate(() => { document.body.style.zoom = '2'; });

  const geometry = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, input')];
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      outside: controls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).length,
    };
  });
  expect(geometry).toEqual({ horizontalOverflow: false, outside: 0 });
});

test('system locale translates first-run without changing accessible controls', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES' });
  const page = await context.newPage();
  await mockTauri(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Elige tu carpeta de música.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Elegir carpeta…' })).toBeVisible();
  await context.close();
});
