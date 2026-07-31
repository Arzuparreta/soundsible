import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TRACKS = [
  {
    id: 'track-1',
    title: 'Una canción con un título deliberadamente largo para probar límites',
    artist: 'Artista con nombre especialmente largo',
    duration: 245,
    cover: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22600%22 height=%22600%22%3E%3Crect width=%22600%22 height=%22600%22 fill=%22%23d46a10%22/%3E%3Ccircle cx=%22300%22 cy=%22300%22 r=%22180%22 fill=%22%23222%22/%3E%3C/svg%3E',
  },
  { id: 'track-2', title: 'Luz de verano', artist: 'Mar Abierta', duration: 198 },
  { id: 'track-3', title: 'Horizonte', artist: 'La Estación', duration: 221 },
];

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: { id: 'qa-user', username: 'qa', display_name: 'QA', role: 'admin', has_password: true },
      };
    } else if (path === '/api/library') {
      body = { tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    } else if (path === '/api/discovery/music/plan' || path === '/api/discovery/music/dj-plan') {
      body = { tracks: TRACKS.slice(1), items: TRACKS.slice(1), plan: {}, transitions: [] };
    } else if (path === '/api/devices' || path === '/api/paired-devices' || path === '/api/pairing/sessions') {
      body = { devices: [], sessions: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

async function openNowPlaying(page: Page) {
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Una canción/ }).click();
  await page.getByRole('button', { name: /Una canción con un título/ }).last().click();
  const surface = page.locator('[data-player-surface-open]');
  await expect(surface).toBeVisible();
  await surface.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function snapCarousel(page: Page, panel: 'queue' | 'stage' | 'browser') {
  await page.locator('[data-now-playing-carousel]').evaluate(async (element, destination) => {
    const carousel = element as HTMLElement;
    const target = carousel.querySelector<HTMLElement>(`[data-now-playing-tile="${destination}"]`)!;
    const previousBehavior = carousel.style.scrollBehavior;
    carousel.style.scrollBehavior = 'auto';
    // Measured off the rects, like the component does: `offsetLeft` is relative
    // to the positioned workspace, not to the scroller, so it carries padding.
    carousel.scrollLeft += target.getBoundingClientRect().left - carousel.getBoundingClientRect().left;
    carousel.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    carousel.style.scrollBehavior = previousBehavior;
  }, panel);
}

test.beforeEach(async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'compact player regression');
  await mockEngine(page);
});

test('Now Playing keeps the visible card interactive after both lateral round trips', async ({ page }) => {
  await openNowPlaying(page);
  const carousel = page.locator('[data-now-playing-carousel]');
  const stage = page.locator('[data-now-playing-tile="stage"]');

  for (const destination of ['queue', 'browser']) {
    const side = page.locator(`[data-now-playing-tile="${destination}"]`);
    await snapCarousel(page, destination as 'queue' | 'browser');

    // During native movement the tile that received the gesture remains the
    // only interactive one. It is never made inert underneath the finger.
    await expect(stage).not.toHaveAttribute('inert', '');
    await page.waitForTimeout(220);
    await expect(side).not.toHaveAttribute('inert', '');
    await expect(stage).toHaveAttribute('inert', '');

    await snapCarousel(page, 'stage');
    await expect(side).not.toHaveAttribute('inert', '');
    await page.waitForTimeout(220);
    await expect(stage).not.toHaveAttribute('inert', '');
    await expect(side).toHaveAttribute('inert', '');

    const transport = stage.getByRole('button', { name: /Reintentar|Pausa|Reproducir/ }).first();
    await transport.evaluate((element) => {
      (window as typeof window & { __playerTapCount?: number }).__playerTapCount = 0;
      element.addEventListener('click', () => {
        const target = window as typeof window & { __playerTapCount?: number };
        target.__playerTapCount = (target.__playerTapCount ?? 0) + 1;
      }, { once: true });
    });
    await expect.poll(() => transport.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    const transportBox = await transport.boundingBox();
    expect(transportBox).not.toBeNull();
    await page.touchscreen.tap(
      transportBox!.x + transportBox!.width / 2,
      transportBox!.y + transportBox!.height / 2,
    );
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & { __playerTapCount?: number }).__playerTapCount,
    )).toBe(1);
  }
});

test('Auto stays anchored, contained and exposes booth and route as mobile sheets', async ({ page }) => {
  await openNowPlaying(page);
  const nowPlayingCover = await page.locator('[data-now-playing-cover-slot]').boundingBox();
  expect(nowPlayingCover).not.toBeNull();

  await page.getByRole('tab', { name: 'AUTO' }).click();
  const surface = page.locator('[data-player-surface-open]');
  const autoCover = page.locator('[data-auto-cover-slot]');
  await expect(page.locator('[data-mobile-cover-anchored]')).toBeAttached();
  await expect(autoCover).toBeVisible();
  await expect.poll(async () => {
    const box = await autoCover.boundingBox();
    return box ? Math.abs(box.y - nowPlayingCover!.y) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(2);

  const autoBox = await autoCover.boundingBox();
  expect(autoBox).not.toBeNull();
  expect(Math.abs(autoBox!.x - nowPlayingCover!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(autoBox!.y - nowPlayingCover!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(autoBox!.width - nowPlayingCover!.width)).toBeLessThanOrEqual(2);

  const containment = await surface.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(containment.scrollLeft).toBe(0);
  expect(containment.scrollTop).toBe(0);
  expect(containment.overflow).toBe('clip');

  for (const locator of [
    autoCover,
    page.getByRole('button', { name: /Cabina/ }),
    page.getByRole('button', { name: /Ruta/ }),
  ]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }

  const accessibility = await new AxeBuilder({ page })
    .include('[data-player-surface-open]')
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole('button', { name: /Cabina/ }).click();
  const booth = page.getByRole('dialog', { name: 'Controles de la cabina' });
  await expect(booth).toBeVisible();
  await expect(booth.getByRole('textbox', { name: /Dile a la cabina/ })).toBeVisible();
  await booth.getByRole('button', { name: 'Cerrar' }).click();

  await page.getByRole('button', { name: /Ruta/ }).click();
  const route = page.getByRole('dialog', { name: 'A continuación' });
  await expect(route).toBeVisible();
  await expect(route).toContainText(/Luz de verano|Horizonte|El DJ aún está preparando/);
  const routeBox = await route.boundingBox();
  expect(routeBox!.x).toBeGreaterThanOrEqual(0);
  expect(routeBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('Auto composition stays inside compact portrait and landscape viewports', async ({ page }) => {
  test.setTimeout(60_000);
  const viewports = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ];
  await page.setViewportSize(viewports[0]);
  await openNowPlaying(page);
  await page.getByRole('tab', { name: 'AUTO' }).click();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([
      viewport.width,
      viewport.height,
    ]);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    for (const [name, locator] of [
      ['cover', page.locator('[data-auto-cover-slot]')],
      ['booth', page.getByRole('button', { name: /Cabina/ })],
      ['route', page.getByRole('button', { name: /Ruta/ })],
    ] as const) {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x, `${name} left at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-1);
      expect(box!.y, `${name} top at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${name} right at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height, `${name} bottom at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(viewport.height + 1);
    }
  }
});
