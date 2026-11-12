import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';
import { settle } from './settle';

/**
 * Settings → Scrobbling in a real layout: the search lands on a service, a
 * token goes through the real prompt, and the rows fit a phone.
 */

const CONNECTED = {
  connected: true, enabled: true, username: 'ana', server: '', state: 'ok', pending: 0, last_sent_at: 1_794_440_000, error: '',
};

interface Engine { listenbrainz: Record<string, unknown>; lastfm: Record<string, unknown>; calls: { method: string; path: string; body: unknown }[] }

async function mockScrobbling(page: Page): Promise<Engine> {
  await mockMusicEngine(page);
  const engine: Engine = {
    listenbrainz: { connected: false },
    lastfm: { connected: false, available: true, authorizing: false },
    calls: [],
  };
  const status = () => ({
    services: [
      { service: 'listenbrainz', ...engine.listenbrainz },
      { service: 'lastfm', ...engine.lastfm },
      { service: 'maloja', connected: false },
    ],
    custom_servers: true,
    lastfm_app: { configured: true, from_environment: false },
  });
  await page.route((url) => url.pathname.startsWith('/api/scrobble'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') engine.calls.push({ method, path, body: request.postDataJSON() });
    if (method === 'PUT' && path === '/api/scrobble/listenbrainz') engine.listenbrainz = { ...CONNECTED };
    if (method === 'PATCH' && path === '/api/scrobble/listenbrainz') {
      engine.listenbrainz = { ...engine.listenbrainz, enabled: request.postDataJSON().enabled };
    }
    if (path === '/api/scrobble/lastfm/authorize') {
      engine.lastfm = { ...engine.lastfm, authorizing: true };
      await route.fulfill({ json: { url: 'https://www.last.fm/api/auth/?api_key=k&token=t' } });
      return;
    }
    await route.fulfill({ json: status() });
  });
  return engine;
}

test('the settings search finds a scrobbling service and lands on it', async ({ page }) => {
  await mockScrobbling(page);
  await page.goto('/player/#/settings');
  await page.getByPlaceholder('Buscar en ajustes').fill('last.fm');
  await page.locator('[data-settings-page]').getByRole('button', { name: /Last\.fm/ }).first().click();

  await expect(page).toHaveURL(/#\/settings\/scrobbling\?q=last\.fm&setting=scrobble-lastfm$/);
  const group = page.locator('[data-setting="scrobble-lastfm"]');
  await expect(group).toBeInViewport();
  await expect(group.getByRole('button', { name: /Conectar Last\.fm/ })).toBeVisible();
});

test('a token goes in through the prompt, and the service can then be paused', async ({ page }) => {
  const engine = await mockScrobbling(page);
  await page.goto('/player/#/settings/scrobbling');
  const group = page.locator('[data-setting="scrobble-listenbrainz"]');
  await group.getByRole('button', { name: /Conectar ListenBrainz/ }).click();

  await page.getByLabel('Token de usuario').fill('lb-token');
  await page.getByRole('button', { name: 'Conectar', exact: true }).click();

  const toggle = group.getByRole('switch', { name: 'Enviar lo que escucho' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByText('Conectado como ana')).toBeVisible();
  await expect(group.getByText('Al día')).toBeVisible();
  expect(engine.calls[0]).toEqual({ method: 'PUT', path: '/api/scrobble/listenbrainz', body: { token: 'lb-token', server: '' } });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(engine.calls[1]).toEqual({ method: 'PATCH', path: '/api/scrobble/listenbrainz', body: { enabled: false } });
});

test('connecting Last.fm offers a real link to its page, opened in a new tab', async ({ page }) => {
  await mockScrobbling(page);
  await page.goto('/player/#/settings/scrobbling');
  const group = page.locator('[data-setting="scrobble-lastfm"]');
  await group.getByRole('button', { name: /Conectar Last\.fm/ }).click();

  const link = group.getByRole('link', { name: /Abrir Last\.fm/ });
  await expect(link).toHaveAttribute('href', 'https://www.last.fm/api/auth/?api_key=k&token=t');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(group.getByRole('button', { name: /Terminar la conexión/ })).toBeEnabled();
});

test('every row fits the screen and the section is accessible', async ({ page }) => {
  const engine = await mockScrobbling(page);
  engine.listenbrainz = { ...CONNECTED, state: 'retrying', pending: 12, error: 'http_503' };
  engine.lastfm = { ...CONNECTED, username: 'ana_fm', available: true, authorizing: false, state: 'reconnect', pending: 3 };
  await page.goto('/player/#/settings/scrobbling');
  const settings = page.locator('[data-settings-page]');
  await expect(settings.getByText('ListenBrainz no responde. Pendientes de enviar: 12')).toBeVisible();
  await expect(settings.getByText('El acceso fue revocado. Pendientes de enviar: 3')).toBeVisible();

  await settle(page, '[data-settings-page]');
  // The longest status sentence sits beside its label; neither may push the page sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const row of await settings.locator('[data-scrobble-state]').all()) {
    const box = (await row.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  const results = await new AxeBuilder({ page })
    .include('[data-settings-page]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
