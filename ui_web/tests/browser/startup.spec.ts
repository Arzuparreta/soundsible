import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function engine(page: Page, authWait = Promise.resolve(), login = true) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      await authWait;
      body = { requires_login: login, user: null };
    } else if (path === '/api/library') {
      body = { tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') body = [];
    else if (path.endsWith('/preview')) body = { valid: true };
    else if (path === '/api/downloader/queue') body = { queue: [], logs: [] };
    await route.fulfill({ json: body });
  });
}

async function visibleLoader(page: Page) {
  await expect(page.locator('#startup-message')).toHaveText('Cargando Soundsible…');
  await expect(page.locator('#startup-screen')).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
  await expect(page.locator('.startup-logo')).toHaveJSProperty('naturalWidth', 512);
}

async function captureLoader(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  // A screenshot must complete while the resource is still withheld: computed
  // visibility alone cannot prove that a render-blocked document has painted.
  // WebKit's document.fonts.ready waits for document load, including withheld
  // modules/styles. This launch surface intentionally uses only system fonts.
  const previous = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
  process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
  try { await page.screenshot({ path, animations: 'disabled', timeout: 5_000 }); }
  finally {
    if (previous === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = previous;
  }
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lang', 'es'));
});

test('HTML paints the branded loader before JavaScript arrives', async ({ page }) => {
  const scripts = gate();
  await engine(page);
  await page.route(/\.(?:js|tsx)(?:\?|$)/, async (route) => {
    await scripts.promise;
    await route.continue();
  });
  await page.goto('/player/', { waitUntil: 'commit' });
  try {
    await visibleLoader(page);
    await expect(page.locator('#startup-reload')).toBeHidden();
    await captureLoader(page, 'waiting-for-javascript');
    const results = await new AxeBuilder({ page }).include('#startup-screen')
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { scripts.release(); }
  await expect(page.getByRole('heading', { name: 'Entrar', exact: true })).toBeVisible();
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

for (const destination of ['player', 'login', 'invite']) {
  test(`waits for session, then reveals ${destination}`, async ({ page }) => {
    const auth = gate();
    await engine(page, auth.promise, destination !== 'player');
    await page.goto(destination === 'invite' ? '/player/#/invite/startup-test' : '/player/', { waitUntil: 'commit' });
    try { await visibleLoader(page); } finally { auth.release(); }
    await expect(page.locator('#startup-screen')).toHaveCount(0);
    await expect(page.locator('#app')).not.toHaveAttribute('inert');
    const ready = destination === 'login' ? page.locator('#login-username')
      : destination === 'invite' ? page.locator('#invite-username') : page.locator('nav:visible').first();
    await expect(ready).toBeVisible();
  });
}

test('slow startup offers reload and can still finish', async ({ page }) => {
  const scripts = gate();
  await page.clock.install();
  await engine(page);
  // Hold modules, not auth: the API's own timeout can legitimately resolve the
  // session into its offline screen before the 15-second launch threshold.
  await page.route(/\.(?:js|tsx)(?:\?|$)/, async (route) => {
    await scripts.promise;
    await route.continue();
  });
  await page.goto('/player/', { waitUntil: 'commit' });
  try {
    await visibleLoader(page);
    await page.clock.fastForward(15_000);
    await expect(page.locator('#startup-message')).toHaveText('Está tardando más de lo habitual.');
    await expect(page.getByRole('button', { name: 'Recargar' })).toBeVisible();
  } finally { scripts.release(); }
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await page.clock.fastForward(20_000);
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

test('failed entry module offers a working reload', async ({ page }) => {
  await engine(page);
  const entry = /\/(?:src\/main\.tsx|assets\/index-[^/]+\.js)(?:\?|$)/;
  await page.route(entry, (route) => route.abort());
  await page.goto('/player/', { waitUntil: 'commit' });
  await expect(page.locator('#startup-message')).toHaveText('No se ha podido cargar Soundsible.');
  await page.unroute(entry);
  await page.getByRole('button', { name: 'Recargar' }).click();
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`respects ${theme} theme and reduced motion on a narrow screen`, async ({ page }) => {
    const auth = gate();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    await engine(page, auth.promise);
    await page.goto('/player/', { waitUntil: 'commit' });
    try {
      await visibleLoader(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.startup-waves span').first()).toHaveCSS('animation-name', 'none');
      const results = await new AxeBuilder({ page }).include('#startup-screen')
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
      expect(results.violations).toEqual([]);
    } finally { auth.release(); }
    await expect(page.locator('#startup-screen')).toHaveCount(0);
  });
}

test('musical bars animate when motion is allowed', async ({ page }) => {
  const auth = gate();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await engine(page, auth.promise);
  await page.goto('/player/', { waitUntil: 'commit' });
  try {
    await visibleLoader(page);
    await expect(page.locator('.startup-waves span').first()).toHaveCSS('animation-name', 'startup-wave');
    await expect(page.locator('#startup-screen')).toHaveCSS('transition-duration', '0.18s');
  } finally { auth.release(); }
  await expect(page.locator('#startup-screen')).toHaveCount(0);
});

for (const [lang, message] of [['en', 'Loading Soundsible…'], ['fr', 'Chargement de Soundsible…'], ['zh', '正在加载 Soundsible…'], ['unknown', 'Loading Soundsible…']]) {
  test(`loads the ${lang} startup copy without dictionaries`, async ({ page }) => {
    const auth = gate();
    await page.addInitScript((value) => localStorage.setItem('lang', value), lang);
    await engine(page, auth.promise);
    await page.goto('/player/', { waitUntil: 'commit' });
    try { await expect(page.locator('#startup-message')).toHaveText(message); }
    finally { auth.release(); }
  });
}

test('production CSS can arrive late without hiding the loader', async ({ page }) => {
  test.skip(!test.info().config.metadata.startupProduction, 'External CSS exists only in the production bundle.');
  const styles = gate();
  await engine(page);
  await page.route(/\.css$/, async (route) => {
    await styles.promise;
    await route.continue();
  });
  await page.goto('/player/', { waitUntil: 'commit' });
  try {
    await visibleLoader(page);
    await expect(page.locator('link[data-boot-style]').first()).toHaveAttribute('media', 'print');
    await captureLoader(page, 'waiting-for-styles');
  } finally { styles.release(); }
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.locator('link[data-boot-style]').first()).toHaveAttribute('media', 'all');
});

test('production CSS failure exposes recovery', async ({ page }) => {
  test.skip(!test.info().config.metadata.startupProduction, 'External CSS exists only in the production bundle.');
  await engine(page);
  await page.route(/\.css$/, (route) => route.abort());
  await page.goto('/player/', { waitUntil: 'commit' });
  await expect(page.locator('#startup-message')).toHaveText('No se ha podido cargar Soundsible.');
  await expect(page.getByRole('button', { name: 'Recargar' })).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
});

test('cached PWA shell includes the loader and reopens offline', async ({ page, context, browserName }) => {
  test.skip(!test.info().config.metadata.startupProduction, 'Service workers are disabled in development.');
  test.skip(browserName === 'webkit', 'Playwright WebKit offline navigation fails with an internal browser error before returning the cached document.');
  await engine(page);
  await page.goto('/player/');
  await expect(page.locator('#login-username')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('soundsible-shell-v1');
    return Boolean(await cache.match('/player/'));
  })).toBe(true);
  // The first navigation installs the worker after its assets have arrived.
  // A controlled online launch populates the existing immutable asset cache.
  await page.reload();
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
  await context.setOffline(true);
  const response = await page.reload({ waitUntil: 'commit' });
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await response!.text()).toContain('id="startup-screen"');
  // Auth keeps its existing offline fallback. WebKit service-worker requests
  // bypass Playwright routing, so that screen can be the disconnected player.
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
});
