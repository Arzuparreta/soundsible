import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('Settings finds the DJ mixing switch and saves whole songs to the account', async ({ page }) => {
  await mockMusicEngine(page);
  const patches: unknown[] = [];
  await page.route((url) => url.pathname === '/api/discovery/settings', async (route) => {
    const base = { learning_enabled: true, autoplay_enabled: false, volume_leveling: true, dj_mixing: true };
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      await route.fulfill({ json: { ...base, ...body } });
      return;
    }
    await route.fulfill({ json: base });
  });

  await page.goto('/player/#/settings');
  // Found by what a listener would call the thing they want gone.
  await page.getByPlaceholder('Buscar en ajustes').fill('fundido');
  await page.locator('[data-settings-page]').getByRole('button', { name: /Mezclar entre canciones/ }).click();

  const row = page.locator('[data-setting="dj-mixing"]');
  await expect(row).toBeInViewport();
  const toggle = row.getByRole('switch', { name: 'Mezclar entre canciones' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => patches).toEqual([{ dj_mixing: false }]);
});
