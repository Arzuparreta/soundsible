import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type InterfaceSize = 'compact' | 'normal' | 'large';

const TRACKS = [
  {
    id: 'track-1',
    title: 'Una canción con un título deliberadamente largo para probar límites',
    artist: 'Artista con nombre especialmente largo',
    album: 'Álbum de prueba',
    duration: 245,
  },
  { id: 'track-2', title: 'Luz de verano', artist: 'Mar Abierta', duration: 198 },
  { id: 'track-3', title: 'Horizonte', artist: 'La Estación', duration: 221 },
];

async function mockEngine(page: Page, authenticated: boolean) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = authenticated
        ? {
            requires_login: true,
            user: {
              id: 'qa-user',
              username: 'qa',
              display_name: 'Usuario de accesibilidad',
              role: 'admin',
              has_password: true,
            },
          }
        : { requires_login: true, user: null };
    } else if (path === '/api/library') {
      body = {
        tracks: TRACKS,
        playlists: { 'Lista con nombre largo': ['track-1', 'track-2'] },
        settings: {},
        podcast_subscriptions: [],
      };
    } else if (path === '/api/library/favourites') {
      body = ['track-2'];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: true };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/devices') {
      body = { devices: [] };
    } else if (path === '/api/paired-devices') {
      body = { devices: [] };
    } else if (path === '/api/pairing/sessions') {
      body = { sessions: [] };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function installPreferences(page: Page, size?: InterfaceSize, highContrast = false) {
  await page.addInitScript(
    ({ selectedSize, contrast }) => {
      localStorage.clear();
      if (selectedSize) localStorage.setItem('soundsible:interface-size', selectedSize);
      if (contrast) localStorage.setItem('soundsible:high-contrast', 'true');
      localStorage.setItem('lang', 'es');
    },
    { selectedSize: size, contrast: highContrast },
  );
}

async function assertGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...document.querySelectorAll<HTMLElement>('button, input, select, a[href]')].filter(visible);
    const outside = controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .map((element) => `${element.tagName}:${element.getAttribute('aria-label') ?? element.textContent?.trim()}`);
    const undersized = controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 24 || rect.height < 24;
      })
      .map((element) => `${element.tagName}:${element.getAttribute('aria-label') ?? element.textContent?.trim()}`);
    const clippedFunctionalText = [...document.querySelectorAll<HTMLElement>('h1, h2, label, output, button')]
      .filter(visible)
      .filter((element) => Boolean(element.textContent?.trim()))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.textOverflow === 'ellipsis') return false;
        if (style.overflowX === 'visible') return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => `${element.tagName}:${element.textContent?.trim()}`);
    const clippedNavigationLabels = [...document.querySelectorAll<HTMLElement>('nav a span')]
      .filter(visible)
      .filter((element) => (
        element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1
      ))
      .map((element) => element.textContent?.trim());
    return {
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      bodyOverflow: document.body.scrollWidth > innerWidth + 1,
      outside,
      undersized,
      clippedFunctionalText,
      clippedNavigationLabels,
    };
  });

  expect(geometry).toEqual({
    documentOverflow: false,
    bodyOverflow: false,
    outside: [],
    undersized: [],
    clippedFunctionalText: [],
    clippedNavigationLabels: [],
  });
}

test.describe('interface scale geometry', () => {
  for (const size of ['compact', 'normal', 'large'] as const) {
    test(`${size} keeps Settings inside mobile and desktop viewports`, async ({ page }) => {
      await mockEngine(page, true);
      await installPreferences(page, size);
      await page.goto('/player/#/settings');
      await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-interface-size', size);
      await assertGeometry(page);
    });
  }

  test('Compact preserves the legacy density contract exactly', async ({ page }) => {
    await mockEngine(page, true);
    await installPreferences(page, 'compact');
    await page.goto('/player/#/settings');
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    const desktop = page.viewportSize()!.width >= 1024;
    const tokens = await page.locator('html').evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        body: styles.getPropertyValue('--text-body').trim(),
        row: styles.getPropertyValue('--row-h').trim(),
        control: styles.getPropertyValue('--control-h').trim(),
        cover: styles.getPropertyValue('--cover-sm').trim(),
        gutter: styles.getPropertyValue('--gutter').trim(),
      };
    });
    expect(tokens).toEqual(desktop
      ? { body: '14px', row: '44px', control: '36px', cover: '36px', gutter: '24px' }
      : { body: '15px', row: '56px', control: '44px', cover: '44px', gutter: '16px' });
  });

  test('missing preference migrates every existing device to Normal', async ({ page }) => {
    await mockEngine(page, false);
    await installPreferences(page);
    await page.goto('/player/');
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-interface-size', 'normal');
    await assertGeometry(page);
  });

  test('visual accessibility remains available on invitation screens', async ({ page }) => {
    await mockEngine(page, false);
    await installPreferences(page, 'normal');
    await page.goto('/player/#/invite/accessibility-fixture');
    const opener = page.getByRole('button', { name: 'Abrir ajustes de accesibilidad visual' });
    await expect(opener).toBeVisible();
    await opener.click();
    await expect(page.getByRole('dialog', { name: 'Accesibilidad' })).toBeVisible();
    await assertGeometry(page);
  });

  test('large enhanced-contrast accessibility dialog remains usable before login', async ({ page }) => {
    await mockEngine(page, false);
    await installPreferences(page, 'large', true);
    await page.goto('/player/');
    await page.getByRole('button', { name: 'Abrir ajustes de accesibilidad visual' }).click();
    const dialog = page.getByRole('dialog', { name: 'Accesibilidad' });
    await expect(dialog).toBeVisible();
    // WebKit can expose the sheet to Axe during the first animation frame,
    // when ancestor opacity is still near zero and every descendant appears to
    // have dark blended text. Audit the settled UI, not an intermediate frame.
    await dialog.evaluate(async (element) => {
      const animations = element.getAnimations({ subtree: true });
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    await assertGeometry(page);

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('large mode reflows through the narrow and short edge matrix', async ({ page, browserName }) => {
    await mockEngine(page, true);
    await installPreferences(page, 'large');
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 768, height: 1024 },
      { width: 1024, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/player/#/settings');
      await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
      await assertGeometry(page);
    }
    expect(['chromium', 'webkit']).toContain(browserName);
  });

  test('large mode keeps every primary application surface inside the viewport', async ({ page }) => {
    await mockEngine(page, true);
    await installPreferences(page, 'large');
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (const route of ['/', '/favourites', '/search', '/playlists', '/podcasts', '/downloads']) {
      await page.goto(`/player/#${route}`);
      await expect(page.locator('main .view')).toBeVisible();
      await assertGeometry(page);
    }

    expect(pageErrors).toEqual([]);
  });

  test('large Now Playing surface reflows after selecting a library track', async ({ page }) => {
    await mockEngine(page, true);
    await installPreferences(page, 'large');
    await page.goto('/player/#/');
    const track = page.getByRole('button', {
      name: /Reproducir Una canción con un título deliberadamente largo.*Artista con nombre especialmente largo/,
    });
    await expect(track).toBeVisible();
    await track.click();

    const player = page.getByRole('button', {
      name: /Una canción con un título deliberadamente largo/,
    }).last();
    await expect(player).toBeVisible();
    await player.click();
    await expect(page.getByRole('heading', {
      name: 'Una canción con un título deliberadamente largo para probar límites',
    })).toBeVisible();
    await assertGeometry(page);
  });

  test('representative large-mode surface matches its reviewed snapshot', async ({ page }) => {
    await mockEngine(page, true);
    await installPreferences(page, 'large', true);
    await page.goto('/player/#/settings');
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    await expect(page).toHaveScreenshot('settings-large-high-contrast.png', { fullPage: false });
  });
});
