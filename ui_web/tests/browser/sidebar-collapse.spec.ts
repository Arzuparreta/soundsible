import { expect, test, type Page } from '@playwright/test';
import { fixtureStream, openMiniPlayer } from './music-browser-fixture';
import { settle } from './settle';

const ALBUM_TRACKS = Array.from({ length: 18 }, (_, index) => ({
  id: `sidebar-track-${index + 1}`,
  title: `Pista ${index + 1}`,
  artist: `Artista ${index % 6}`,
  album: `Álbum ${(index % 12) + 1}`,
  album_id: `alb-${(index % 12) + 1}`,
  duration: 180 + index,
  in_library: true,
}));

const ALBUM_ITEMS = Array.from({ length: 12 }, (_, index) => ({
  id: `alb-${index + 1}`,
  title: `Álbum ${index + 1}`,
  artist: `Artista ${index % 6}`,
  artists: [{ id: `art-${index % 6}`, name: `Artista ${index % 6}` }],
  cover_track_id: `sidebar-track-${index + 1}`,
  track_count: 2,
}));

async function mockSidebarEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: { id: 'qa', username: 'qa', display_name: 'QA', role: 'admin', has_password: true },
      };
    } else if (path === '/api/library') {
      body = { tracks: ALBUM_TRACKS, playlists: { Nocturna: ['sidebar-track-1'] }, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/albums') {
      body = { albums: ALBUM_ITEMS, sort: 'recent' };
    } else if (path === '/api/library/saved-entities') {
      body = { entities: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue/status' || path === '/api/downloader/queue') {
      body = {
        queue: [
          { id: 'dl-1', status: 'downloading', display_title: 'Uno' },
          { id: 'dl-2', status: 'pending', display_title: 'Dos' },
        ],
        is_processing: true,
        logs: [],
      };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    } else if (path === '/api/devices' || path === '/api/paired-devices' || path === '/api/pairing/sessions') {
      body = { devices: [], sessions: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await fixtureStream(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('sidebar-fixture-initialized')) {
      localStorage.clear();
      sessionStorage.setItem('sidebar-fixture-initialized', 'true');
    }
    localStorage.setItem('lang', 'es');
  });
}

async function measureSidebarGeometry(page: Page) {
  return page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) throw new Error('Expected desktop aside element');
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return !el.closest('[inert], [aria-hidden="true"]')
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...aside.querySelectorAll<HTMLElement>('button, a[href]')].filter(visible);
    const undersized = controls
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width < 24 - 0.01 || rect.height < 24 - 0.01;
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim());
    const clippedLabels = [...aside.querySelectorAll<HTMLElement>('nav a span, nav button span')]
      .filter(visible)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.textContent?.trim());
    const asideRect = aside.getBoundingClientRect();
    return {
      asideWidth: Math.round(asideRect.width),
      controlCount: controls.length,
      undersized,
      clippedLabels,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'), 'desktop sidebar only renders at >=1024px');
  await mockSidebarEngine(page);
});

for (const size of ['compact', 'normal', 'large'] as const) {
  test(`desktop sidebar toggles cleanly at ${size} and preserves geometry`, async ({ page }) => {
    await page.addInitScript((selected) => {
      localStorage.setItem('soundsible:interface-size', selected);
    }, size);

    await page.goto('/player/#/library?view=songs');
    const aside = page.locator('aside');
    await expect(aside).toBeVisible();
    await expect(aside.getByRole('link', { name: 'soundsible', exact: true })).toBeVisible();

    const expanded = await measureSidebarGeometry(page);
    expect(expanded.asideWidth).toBeGreaterThanOrEqual(208);
    expect(expanded.controlCount).toBeGreaterThanOrEqual(13);
    expect(expanded.undersized).toEqual([]);
    expect(expanded.clippedLabels).toEqual([]);
    expect(expanded.documentOverflow).toBe(false);

    await aside.getByRole('button', { name: 'Contraer barra lateral', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');
    await expect(aside.getByRole('link', { name: 'soundsible', exact: true })).toHaveCount(0);

    const collapsed = await measureSidebarGeometry(page);
    expect(collapsed.asideWidth).toBe(68);
    expect(collapsed.controlCount).toBe(12);
    expect(collapsed.undersized).toEqual([]);
    expect(collapsed.clippedLabels).toEqual([]);
    expect(collapsed.documentOverflow).toBe(false);

    // Persists across reload and restores cleanly.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');
    await expect(aside.getByRole('button', { name: 'Expandir barra lateral', exact: true })).toBeVisible();

    await aside.getByRole('button', { name: 'Expandir barra lateral', exact: true }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-collapsed');
    await expect(aside.getByRole('link', { name: 'soundsible', exact: true })).toBeVisible();
  });
}

test('collapsing widens center workspace beside Docked Now Playing and re-measures grids', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
  await page.goto('/player/#/library?view=songs');
  await page.getByRole('button', { name: /Reproducir Pista 1/ }).first().click();
  await openMiniPlayer(page, /^NORMAL:/);
  await settle(page, '[data-player-surface-open]');
  await expect(page.locator('[data-player-surface-open]')).toHaveAttribute('data-docked', '');

  await page.locator('aside').getByRole('link', { name: 'Álbumes', exact: true }).click();
  await expect(page).toHaveURL(/#\/library\?view=albums$/);
  const scrollport = page.locator('#app [data-primary-scroll]:visible').first();
  await expect(scrollport.locator('a').first()).toBeVisible();

  const expandedCenter = (await scrollport.boundingBox())!;
  await page.locator('aside').getByRole('button', { name: 'Contraer barra lateral', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');

  const collapsedCenter = (await scrollport.boundingBox())!;
  expect(collapsedCenter.width - expandedCenter.width).toBeGreaterThanOrEqual(150);

  // Cards reflow cleanly without horizontal document overflow or vertical overlap.
  const gridCheck = await scrollport.evaluate((el) => {
    const cards = [...el.querySelectorAll<HTMLElement>('a')].filter((card) => card.getBoundingClientRect().height > 0);
    const rects = cards.map((card) => card.getBoundingClientRect());
    let overlaps = false;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i], b = rects[j];
        if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
          overlaps = true;
        }
      }
    }
    return {
      cardCount: cards.length,
      overlaps,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  expect(gridCheck.cardCount).toBeGreaterThanOrEqual(6);
  expect(gridCheck.overlaps).toBe(false);
  expect(gridCheck.documentOverflow).toBe(false);
});
