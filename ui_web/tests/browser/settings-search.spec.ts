import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { settle } from './settle';

/**
 * The settings search, end to end: a result opens its submenu scrolled to the
 * row it names, and the search is still there on the way back. jsdom has no
 * layout, so whether the row actually ends up on screen is only provable here.
 */

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: {
          id: 'qa-user',
          username: 'qa',
          display_name: 'Usuario de búsqueda',
          role: 'admin',
          has_password: true,
        },
      };
    } else if (path === '/api/library') {
      body = { tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: true };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/devices' || path === '/api/paired-devices') {
      body = { devices: [] };
    } else if (path === '/api/pairing/sessions') {
      body = { sessions: [] };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test.beforeEach(async ({ page }) => {
  await mockEngine(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('soundsible:interface-size', 'normal');
    localStorage.setItem('lang', 'es');
  });
});

test('a result lands on its row, and the search survives the way back', async ({ page }) => {
  await page.goto('/player/#/settings');
  const settings = page.locator('[data-settings-page]');
  const search = page.getByPlaceholder('Buscar en ajustes');
  const desktop = page.viewportSize()!.width >= 1024;

  await search.fill('yt-dlp');
  const result = settings.getByRole('button', { name: /Auto-actualizar yt-dlp/ });
  await expect(result).toBeVisible();
  await expect(result.locator('mark')).toHaveText(['yt', 'dlp']);

  await result.click();
  await expect(page).toHaveURL(/#\/settings\/downloads\?q=yt-dlp&setting=auto-update-ytdlp$/);
  const row = settings.locator('[data-setting="auto-update-ytdlp"]');
  await expect(row).toHaveAttribute('data-setting-flash', '');
  await expect(row).toBeInViewport();
  // It was below the fold: the submenu scrolled to it rather than opening at the top.
  const scroller = settings.locator('[data-primary-scroll]');
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  if (desktop) {
    await expect(search).toHaveValue('yt-dlp');
    await expect(result).toHaveAttribute('aria-current', 'true');
    return;
  }

  await page.goBack();
  await expect(page).toHaveURL(/#\/settings\?q=yt-dlp$/);
  await expect(search).toHaveValue('yt-dlp');
  await result.click();
  await expect(row).toBeInViewport();

  await settings.getByRole('button', { name: 'Volver', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\?q=yt-dlp$/);
  await expect(result).toBeVisible();
});

test('a result opens the disclosure its row is folded into', async ({ page }) => {
  await page.goto('/player/#/settings');
  await page.getByPlaceholder('Buscar en ajustes').fill('barra inferior');
  await page.locator('[data-settings-page]').getByRole('button', { name: /Barra inferior/ }).click();

  const disclosure = page.locator('details[data-setting="bottom-bar"]');
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(disclosure).toBeInViewport();
});

test('a deep link to a setting lands on it from a cold start', async ({ page }) => {
  await page.goto('/player/#/settings/library?setting=empty-library');

  const row = page.locator('[data-setting="empty-library"]');
  await expect(row).toHaveAttribute('data-setting-flash', '');
  await expect(row).toBeInViewport();
});

test('search results stay accessible', async ({ page }) => {
  await page.goto('/player/#/settings');
  await page.getByPlaceholder('Buscar en ajustes').fill('volumen');
  const list = page.getByRole('group', { name: 'Resultados de la búsqueda' });
  await expect(list.getByRole('button', { name: /Igualar el volumen/ })).toBeVisible();

  await settle(page, '[data-settings-page]');
  // The results only: on desktop the submenu beside them is audited elsewhere.
  const results = await new AxeBuilder({ page })
    .include('[data-settings-page] [role="group"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
