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

async function holdCarousel(page: Page, selector: string) {
  await page.locator(selector).dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 200,
    clientY: 400,
  });
}

async function releaseCarousel(page: Page, selector: string) {
  await page.locator(selector).dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 80,
    clientY: 400,
  });
}

async function snapPlayerCarousel(
  page: Page,
  scope: 'now-playing' | 'auto',
  panel: string,
) {
  await page.locator(`[data-${scope}-carousel]`).evaluate(async (element, args) => {
    const carousel = element as HTMLElement;
    const target = carousel.querySelector<HTMLElement>(`[data-${args.scope}-tile="${args.panel}"]`)!;
    const previousBehavior = carousel.style.scrollBehavior;
    carousel.style.scrollBehavior = 'auto';
    carousel.scrollLeft += target.getBoundingClientRect().left - carousel.getBoundingClientRect().left;
    carousel.dispatchEvent(new Event('scroll'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    carousel.style.scrollBehavior = previousBehavior;
  }, { scope, panel });
}

async function swipeSurfaceDown(page: Page, targetSelector: string) {
  await page.locator(targetSelector).evaluate((target) => {
    const dispatch = (
      type: 'touchstart' | 'touchmove' | 'touchend',
      x: number,
      y: number,
    ) => {
      const touch = {
        identifier: 7,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
      };
      const touchList = (items: Array<typeof touch>) => Object.assign(items, {
        item: (index: number) => items[index] ?? null,
      });
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touchList(type === 'touchend' ? [] : [touch]) },
        targetTouches: { value: touchList(type === 'touchend' ? [] : [touch]) },
        changedTouches: { value: touchList([touch]) },
      });
      target.dispatchEvent(event);
    };
    dispatch('touchstart', 180, 180);
    dispatch('touchmove', 180, 225);
    dispatch('touchmove', 180, 330);
    dispatch('touchend', 180, 330);
  });
}

test.beforeEach(async ({ page }) => {
  await mockEngine(page);
});

test('Now Playing keeps the visible card interactive after both lateral round trips', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'compact player regression');
  await openNowPlaying(page);
  const carousel = page.locator('[data-now-playing-carousel]');
  const stage = page.locator('[data-now-playing-tile="stage"]');

  for (const destination of ['queue', 'browser']) {
    const side = page.locator(`[data-now-playing-tile="${destination}"]`);
    await holdCarousel(page, '[data-now-playing-carousel]');
    await snapCarousel(page, destination as 'queue' | 'browser');

    // During native movement the tile that received the gesture remains the
    // only interactive one. It is never made inert underneath the finger.
    await expect(stage).not.toHaveAttribute('inert', '');
    await releaseCarousel(page, '[data-now-playing-carousel]');
    await expect(side).not.toHaveAttribute('inert', '');
    await expect(stage).toHaveAttribute('inert', '');

    await holdCarousel(page, '[data-now-playing-carousel]');
    await snapCarousel(page, 'stage');
    await expect(side).not.toHaveAttribute('inert', '');
    await releaseCarousel(page, '[data-now-playing-carousel]');
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

test('Auto reuses the compact workspace, pager and touch lifecycle', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'compact player regression');
  await openNowPlaying(page);
  const nowPlayingStage = await page.locator('[data-now-playing-tile="stage"]').boundingBox();
  expect(nowPlayingStage).not.toBeNull();
  const nowPlayingCover = await page.locator('[data-now-playing-cover-slot]').boundingBox();
  const nowPlayingTransport = await page.locator('[data-player-stage-mode="now-playing"]')
    .getByRole('button', { name: /Reintentar|Pausa|Reproducir/ })
    .first()
    .boundingBox();
  expect(nowPlayingCover).not.toBeNull();
  expect(nowPlayingTransport).not.toBeNull();

  await page.getByRole('tab', { name: 'AUTO' }).click();
  const surface = page.locator('[data-player-stage]');
  const carousel = page.locator('[data-auto-carousel]');
  const autoStage = page.locator('[data-auto-tile="stage"]');
  await expect(autoStage).toBeVisible();
  const autoStageBox = await autoStage.boundingBox();
  expect(autoStageBox).not.toBeNull();
  expect(Math.abs(autoStageBox!.x - nowPlayingStage!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoStageBox!.y - nowPlayingStage!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoStageBox!.width - nowPlayingStage!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoStageBox!.height - nowPlayingStage!.height)).toBeLessThanOrEqual(1);
  const autoCover = await page.locator('[data-auto-cover-slot]').boundingBox();
  const autoTransport = await page.locator('[data-player-stage-mode="auto"]')
    .getByRole('button', { name: /Reintentar|Pausa|Reproducir/ })
    .first()
    .boundingBox();
  expect(autoCover).not.toBeNull();
  expect(autoTransport).not.toBeNull();
  expect(Math.abs(autoCover!.x - nowPlayingCover!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoCover!.y - nowPlayingCover!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoTransport!.x - nowPlayingTransport!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(autoTransport!.y - nowPlayingTransport!.y)).toBeLessThanOrEqual(1);

  const containment = await surface.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(containment.scrollLeft).toBe(0);
  expect(containment.scrollTop).toBe(0);
  expect(containment.overflow).toBe('clip');

  for (const destination of ['browser', 'route'] as const) {
    const side = page.locator(`[data-auto-tile="${destination}"]`);
    await holdCarousel(page, '[data-auto-carousel]');
    await snapPlayerCarousel(page, 'auto', destination);
    await expect(autoStage).not.toHaveAttribute('inert', '');
    await releaseCarousel(page, '[data-auto-carousel]');
    await expect(side).not.toHaveAttribute('inert', '');
    await expect(autoStage).toHaveAttribute('inert', '');

    if (destination === 'browser') {
      const browserPanel = side.locator('aside[data-purpose="auto-neutral"]');
      const libraryCard = side.getByRole('button', { name: /^Biblioteca/ });
      const favouritesCard = side.getByRole('button', { name: /^Favoritos/ });
      const playlistsCard = side.getByRole('button', { name: /^Listas/ });
      await expect(libraryCard).toBeVisible();
      await expect(favouritesCard).toBeVisible();
      await expect(playlistsCard).toBeVisible();
      const [libraryBox, favouritesBox, playlistsBox] = await Promise.all([
        libraryCard.boundingBox(), favouritesCard.boundingBox(), playlistsCard.boundingBox(),
      ]);
      expect(libraryBox).not.toBeNull();
      expect(favouritesBox).not.toBeNull();
      expect(playlistsBox).not.toBeNull();
      expect(Math.abs(favouritesBox!.y - playlistsBox!.y)).toBeLessThanOrEqual(1);
      expect(favouritesBox!.y).toBeGreaterThan(libraryBox!.y + libraryBox!.height);
      expect(Math.abs(favouritesBox!.width - playlistsBox!.width)).toBeLessThanOrEqual(1);
      expect(libraryBox!.width).toBeGreaterThan(favouritesBox!.width + playlistsBox!.width);
      const [tileBox, panelBox] = await Promise.all([side.boundingBox(), browserPanel.boundingBox()]);
      expect(tileBox).not.toBeNull();
      expect(panelBox).not.toBeNull();
      expect(Math.abs(panelBox!.x - tileBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(panelBox!.width - tileBox!.width)).toBeLessThanOrEqual(2);
      const panelRight = panelBox!.x + panelBox!.width;
      const libraryRight = libraryBox!.x + libraryBox!.width;
      const playlistsRight = playlistsBox!.x + playlistsBox!.width;
      expect(Math.abs(libraryRight - playlistsRight)).toBeLessThanOrEqual(1);
      expect(panelRight - libraryRight).toBeLessThanOrEqual(12);
    } else {
      await expect(side.getByRole('heading', { name: 'Ruta preparada' })).toBeVisible();
    }

    await holdCarousel(page, '[data-auto-carousel]');
    await snapPlayerCarousel(page, 'auto', 'stage');
    await expect(side).not.toHaveAttribute('inert', '');
    await releaseCarousel(page, '[data-auto-carousel]');
    await expect(autoStage).not.toHaveAttribute('inert', '');
    await expect(side).toHaveAttribute('inert', '');
  }

  await expect(carousel).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('[data-player-surface-open]').analyze();
  expect(accessibility.violations).toEqual([]);

  await swipeSurfaceDown(page, '[data-auto-tile="stage"]');
  await expect(surface).not.toHaveAttribute('data-player-surface-open');
});

test('mobile route insertion targets stay contextual and aligned', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'compact player regression');
  await openNowPlaying(page);
  await page.getByRole('tab', { name: 'AUTO' }).click();

  const route = page.locator('[data-auto-tile="route"]');
  await holdCarousel(page, '[data-auto-carousel]');
  await snapPlayerCarousel(page, 'auto', 'route');
  await releaseCarousel(page, '[data-auto-carousel]');
  await expect(route).not.toHaveAttribute('inert', '');

  await route.getByRole('button', { name: 'Añadir' }).click();
  const browser = page.locator('[data-auto-tile="browser"]');
  await expect(browser).not.toHaveAttribute('inert', '');
  await browser.getByRole('button', { name: /^Biblioteca/ }).click();
  await browser.getByRole('button', { name: /Luz de verano/ }).first().click();
  await expect(route).not.toHaveAttribute('inert', '');
  await route.getByRole('button', { name: 'Añadir' }).click();
  await expect(browser).not.toHaveAttribute('inert', '');
  await browser.getByRole('button', { name: /Horizonte/ }).first().click();
  await expect(route).not.toHaveAttribute('inert', '');

  const insertionTargets = route.locator('button[aria-label^="Insertar una canción antes de"]');
  await expect(insertionTargets).toHaveCount(2);
  await expect(insertionTargets.first()).toBeHidden();
  await expect(insertionTargets.last()).toBeHidden();

  const carriedRow = route.locator('[draggable="true"]').first();
  await carriedRow.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await expect(insertionTargets.first()).toHaveAttribute('data-placement-active', '');
  await expect(insertionTargets.first()).toBeVisible();
  await expect(insertionTargets.last()).toBeVisible();
  const targetGeometry = await insertionTargets.evaluateAll((targets) => targets.map((target) => {
    const box = target.getBoundingClientRect();
    const previous = target.previousElementSibling?.getBoundingClientRect();
    const following = target.nextElementSibling?.getBoundingClientRect();
    const marker = target.querySelector('span')?.getBoundingClientRect();
    return {
      height: box.height,
      clearsPrevious: !previous || box.top >= previous.bottom,
      clearsFollowing: !following || box.bottom <= following.top,
      markerOffset: marker ? Math.abs((marker.top + marker.height / 2) - (box.top + box.height / 2)) : 99,
    };
  }));
  expect(new Set(targetGeometry.map((target) => target.height)).size).toBe(1);
  expect(targetGeometry.every((target) => target.clearsPrevious && target.clearsFollowing)).toBe(true);
  expect(targetGeometry.every((target) => target.markerOffset <= 1)).toBe(true);
});

test('the shared mode pill and Auto workspace stay contained in compact viewports', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) > 1023, 'compact player regression');
  test.setTimeout(60_000);
  const viewports = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ];
  await page.setViewportSize(viewports[0]);
  await openNowPlaying(page);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([
      viewport.width,
      viewport.height,
    ]);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    for (const mode of ['now-playing', 'auto'] as const) {
      if (mode === 'auto') await page.getByRole('tab', { name: 'AUTO' }).click();
      else await page.getByRole('tab', { name: 'Now Playing' }).click();

      const pill = page.getByRole('tablist');
      const close = page.getByRole('button', { name: 'Cerrar' });
      const pillBox = await pill.boundingBox();
      const closeBox = await close.boundingBox();
      expect(pillBox).not.toBeNull();
      expect(closeBox).not.toBeNull();
      expect(pillBox!.x, `${mode} pill left at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(0);
      expect(pillBox!.x + pillBox!.width, `${mode} pill right at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(viewport.width);
      expect(Math.abs(pillBox!.x + pillBox!.width / 2 - viewport.width / 2), `${mode} pill centering`)
        .toBeLessThanOrEqual(1);
      expect(pillBox!.x + pillBox!.width, `${mode} pill must not overlap close`)
        .toBeLessThanOrEqual(closeBox!.x);

      if (mode === 'now-playing') {
        const searchBox = await page.getByRole('button', { name: /Abrir búsqueda/ }).boundingBox();
        expect(searchBox).not.toBeNull();
        expect(searchBox!.x + searchBox!.width, 'pill must not overlap search').toBeLessThanOrEqual(pillBox!.x);
      }

      const workspace = page.locator(`[data-player-workspace="${mode}"]`);
      await expect(workspace).toBeVisible();
      const box = await workspace.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x, `${mode} left at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-1);
      expect(box!.y, `${mode} top at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${mode} right at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height, `${mode} bottom at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(viewport.height + 1);
    }
  }
});

test('Now Playing and Auto share centered desktop Stage geometry through scale reflows', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1024) <= 1023, 'desktop player regression');
  await page.addInitScript(() => {
    localStorage.setItem('soundsible:interface-size', 'large');
  });
  await page.setViewportSize({ width: 1138, height: 640 });
  await openNowPlaying(page);
  await expect(page.locator('html')).toHaveAttribute('data-interface-size', 'large');

  const geometry = async (mode: 'now-playing' | 'auto') =>
    page.locator(`[data-player-stage-mode="${mode}"]`).evaluate((stage, stageMode) => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };
      };
      const transport = stage.querySelector<HTMLButtonElement>(
        'button[aria-label="Reintentar"], button[aria-label="Pausa"], button[aria-label="Reproducir"]',
      );
      const tile = stage.closest('[data-player-tile]');
      const cover = stage.querySelector('[data-player-cover-slot]');
      const coverArt = cover?.firstElementChild;
      if (!tile || !cover || !coverArt || !transport) throw new Error(`Incomplete ${stageMode} Stage`);
      return {
        body: box(stage),
        tile: box(tile),
        cover: box(cover),
        coverArt: box(coverArt),
        transport: box(transport),
        emptyPresentationElements:
          stage.querySelectorAll(':scope > div[aria-hidden="true"]:empty').length,
      };
    }, mode);

  for (const configuration of [
    { viewport: { width: 1366, height: 768 }, interfaceSize: 'normal' },
    { viewport: { width: 1138, height: 640 }, interfaceSize: 'large' },
    { viewport: { width: 1600, height: 900 }, interfaceSize: 'large' },
  ]) {
    const { viewport, interfaceSize } = configuration;
    await page.setViewportSize(viewport);
    await page.evaluate((size) => {
      document.documentElement.dataset.interfaceSize = size;
      localStorage.setItem('soundsible:interface-size', size);
    }, interfaceSize);
    await expect(page.locator('html')).toHaveAttribute('data-interface-size', interfaceSize);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    await page.getByRole('tab', { name: 'Now Playing' }).click();
    const nowPlaying = await geometry('now-playing');
    await page.getByRole('tab', { name: 'AUTO' }).click();
    await expect(page.locator('[data-player-stage-mode="auto"]')).toBeVisible();
    const auto = await geometry('auto');

    expect(nowPlaying.emptyPresentationElements, `${viewport.width}x${viewport.height} separator`).toBe(0);
    expect(auto.emptyPresentationElements, `${viewport.width}x${viewport.height} Auto separator`).toBe(0);
    expect(nowPlaying.body.bottom).toBeLessThanOrEqual(nowPlaying.tile.bottom + 1);
    expect(auto.body.bottom).toBeLessThanOrEqual(auto.tile.bottom + 1);
    expect(Math.abs(nowPlaying.body.centerX - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.body.centerX - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(nowPlaying.cover.width - nowPlaying.cover.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.cover.width - auto.cover.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.cover.centerX - nowPlaying.cover.centerX)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.cover.centerY - nowPlaying.cover.centerY)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.coverArt.width - nowPlaying.coverArt.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.coverArt.height - nowPlaying.coverArt.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.transport.centerX - nowPlaying.transport.centerX)).toBeLessThanOrEqual(1);
    expect(Math.abs(auto.transport.centerY - nowPlaying.transport.centerY)).toBeLessThanOrEqual(1);
  }
});
