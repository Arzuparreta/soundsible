import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('a missing Settings module offers to reload an outdated tab in place', async ({ page }) => {
  await mockMusicEngine(page);
  const oldBuild = 'a'.repeat(64);
  const newBuild = 'b'.repeat(64);
  let navigations = 0;
  let probes = 0;
  await page.route('**/player/', async route => {
    const navigation = route.request().isNavigationRequest();
    if (navigation) navigations++;
    else probes++;
    const build = navigation && navigations === 1 ? oldBuild : newBuild;
    const response = await route.fetch();
    const body = (await response.text()).replace('</head>', `<meta name="soundsible-build" content="${build}"></head>`);
    await route.fulfill({ response, body });
  });
  await page.route('**/src/routes/Settings.tsx*', route => navigations === 1
    ? route.fulfill({ status: 404 })
    : route.continue());

  await page.goto('/player/#/settings');
  const reload = page.getByRole('button', { name: 'Recargar', exact: true });
  await expect(reload).toBeVisible();
  expect(navigations).toBe(1);

  await reload.click();
  await expect(page.locator('[data-settings-page]')).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  expect(navigations).toBe(2);
  expect(probes).toBe(1);
});
