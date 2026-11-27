import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

interface RectBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function createGate() {
  let open = false;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      open = true;
      resolve();
    };
  });
  return {
    wait: () => (open ? Promise.resolve() : promise),
    release,
  };
}

async function settleFrames(page: Page) {
  await page.waitForFunction(() => !document.getElementById('startup-screen'));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function measureBox(locator: Locator): Promise<RectBox> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    left: box!.x,
    top: box!.y,
    right: box!.x + box!.width,
    bottom: box!.y + box!.height,
    width: box!.width,
    height: box!.height,
  };
}

function expectBoxClose(actual: RectBox, expected: RectBox, fields: (keyof RectBox)[], tolerance = 2) {
  for (const field of fields) {
    expect(Math.abs(actual[field] - expected[field])).toBeLessThanOrEqual(tolerance);
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const scroll = document.querySelector<HTMLElement>('[data-primary-scroll]');
    return {
      docOverflow: doc.scrollWidth - doc.clientWidth,
      scrollOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
    };
  });
  expect(overflow.docOverflow).toBeLessThanOrEqual(1);
  expect(overflow.scrollOverflow).toBeLessThanOrEqual(1);
}

const SAMPLE_TRACKS = TRACKS.slice(0, 6);
const ARTWORK_SVG = (hue: number) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="hsl(${hue},38%,32%)"/></svg>`,
)}`;

test.describe('skeleton alignment and scaling', () => {
  for (const size of ['compact', 'normal', 'large'] as const) {
    test(`/favourites and /songs skeletons match loaded rows at ${size} scale`, async ({ page, isMobile }) => {
      if (!isMobile) await page.setViewportSize({ width: 1366, height: 768 });
      await mockMusicEngine(page);
      await page.addInitScript((ifaceSize) => {
        localStorage.setItem('soundsible:interface-size', ifaceSize);
      }, size);

      let gate = createGate();
      await page.route((url) => url.pathname === '/api/library', async (route) => {
        await gate.wait();
        await route.fulfill({
          json: { tracks: SAMPLE_TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] },
        });
      });
      await page.route('**/api/library/favourites', (route) => route.fulfill({ json: SAMPLE_TRACKS.map((t) => t.id) }));
      await page.route((url) => url.pathname === '/api/library/saved', (route) => route.fulfill({
        json: {
          saved: SAMPLE_TRACKS.map((track) => ({
            keys: [`lib:${track.id}`],
            title: track.title,
            artist: track.artist,
            favourite: true,
          })),
        },
      }));

      for (const routePath of ['/favourites', '/songs'] as const) {
        gate = createGate();
        if (routePath === '/songs') await page.goto('about:blank');
        await page.goto(`/player/#${routePath}`);
        const firstSkel = page.locator('[data-library-scroll] [data-skeleton-row]').first();
        await expect(firstSkel).toBeVisible();
        await expect(page.locator('main [role="status"]')).toHaveCount(1);
        await settleFrames(page);
        await expectNoHorizontalOverflow(page);

        const rowMetrics = await firstSkel.evaluate((row) => {
          const rowTokenH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
          const rowRect = row.getBoundingClientRect();
          const cover = row.querySelector('[data-skeleton-cover]');
          const spans = Array.from(row.children).filter((el) => el.tagName === 'SPAN');
          const copy = spans.find((el) => !el.hasAttribute('data-skeleton-cover') && !el.hasAttribute('data-skeleton-menu'));
          return {
            rowTokenH,
            rowBox: {
              left: rowRect.left,
              top: rowRect.top,
              right: rowRect.right,
              bottom: rowRect.bottom,
              width: rowRect.width,
              height: rowRect.height,
            },
            coverLeft: cover!.getBoundingClientRect().left,
            copyLeft: copy!.getBoundingClientRect().left,
          };
        });
        expect(Math.abs(rowMetrics.rowBox.height - rowMetrics.rowTokenH)).toBeLessThanOrEqual(2);
        if (isMobile) {
          expect(rowMetrics.coverLeft).toBeGreaterThan(rowMetrics.copyLeft);
        } else {
          expect(rowMetrics.coverLeft).toBeLessThan(rowMetrics.copyLeft);
        }

        gate.release();
        const firstLoaded = page.locator(isMobile ? '[data-music-list-row]' : '[data-song-row]').first();
        await expect(firstLoaded).toBeVisible();
        await settleFrames(page);
        const cover = await measureBox(firstLoaded.locator('[data-artwork-surface]').first());
        expect(Math.abs(rowMetrics.coverLeft - cover.left)).toBeLessThanOrEqual(2);
        const title = await measureBox(firstLoaded.locator('[data-row-main], [role=button]').first());
        expect(Math.abs(rowMetrics.copyLeft - title.left)).toBeLessThanOrEqual(2);
        const loadedBox = await measureBox(firstLoaded);
        expectBoxClose(rowMetrics.rowBox, loadedBox, ['left', 'top', 'width', 'height'], 2);
      }
    });
  }

  test('1024x768 at large scale switches shell chrome cleanly without misaligning song rows', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop-width 1024px breakpoint test');
    await page.setViewportSize({ width: 1024, height: 768 });
    await mockMusicEngine(page);
    await page.addInitScript(() => {
      localStorage.setItem('soundsible:interface-size', 'large');
    });

    const gate = createGate();
    await page.route((url) => url.pathname === '/api/library', async (route) => {
      await gate.wait();
      await route.fulfill({
        json: { tracks: SAMPLE_TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] },
      });
    });
    await page.route('**/api/library/favourites', (route) => route.fulfill({ json: SAMPLE_TRACKS.map((t) => t.id) }));
    await page.route((url) => url.pathname === '/api/library/saved', (route) => route.fulfill({
      json: {
        saved: SAMPLE_TRACKS.map((track) => ({
          keys: [`lib:${track.id}`],
          title: track.title,
          artist: track.artist,
          favourite: true,
        })),
      },
    }));

    await page.goto('/player/#/favourites');
    const firstSkel = page.locator('[data-library-scroll] [data-skeleton-row]').first();
    await expect(firstSkel).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);

    const { skelBox, coverLeft, copyLeft } = await firstSkel.evaluate((row) => {
      const r = row.getBoundingClientRect();
      const cover = row.querySelector('[data-skeleton-cover]')!;
      const spans = Array.from(row.children).filter((el) => el.tagName === 'SPAN');
      const copy = spans.find((el) => !el.hasAttribute('data-skeleton-cover') && !el.hasAttribute('data-skeleton-menu'))!;
      return {
        skelBox: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        coverLeft: cover.getBoundingClientRect().left,
        copyLeft: copy.getBoundingClientRect().left,
      };
    });
    // At 1024px desktop list layout still puts artwork on the left even though touch shell is active.
    expect(coverLeft).toBeLessThan(copyLeft);

    gate.release();
    const firstLoaded = page.locator('[data-song-row]').first();
    await expect(firstLoaded).toBeVisible();
    await settleFrames(page);
    const loadedBox = await measureBox(firstLoaded);
    expectBoxClose(skelBox, loadedBox, ['left', 'top', 'width', 'height'], 2);
  });

  test('collapsed sidebar and docked player keep skeletons aligned within the available main column', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop shell chrome test');
    await page.setViewportSize({ width: 1366, height: 768 });
    await mockMusicEngine(page);

    let holdNextLibrary = false;
    let libGate = createGate();
    await page.route((url) => url.pathname === '/api/library', async (route) => {
      if (holdNextLibrary) await libGate.wait();
      await route.fulfill({
        json: { tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] },
      });
    });

    // Collapse the sidebar and verify reloaded /songs aligns inside the wider main column.
    await page.goto('/player/#/albums');
    await expect(page.locator('aside')).toBeVisible();
    await page.locator('aside').getByRole('button', { name: 'Contraer barra lateral', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');

    holdNextLibrary = true;
    libGate = createGate();
    await page.goto('about:blank');
    await page.goto('/player/#/songs');
    const collapsedSkel = page.locator('[data-library-scroll] [data-skeleton-row]').first();
    await expect(collapsedSkel).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const collapsedSkelBox = await measureBox(collapsedSkel);

    holdNextLibrary = false;
    libGate.release();
    const collapsedLoaded = page.locator('[data-song-row]').first();
    await expect(collapsedLoaded).toBeVisible();
    await settleFrames(page);
    expectBoxClose(collapsedSkelBox, await measureBox(collapsedLoaded), ['left', 'top', 'width', 'height'], 2);

    // Expand sidebar back and open docked player, then navigate to artist discovery behind a held route.
    await page.locator('aside').getByRole('button', { name: 'Expandir barra lateral', exact: true }).click();
    const artistGate = createGate();
    await page.route((url) => url.pathname === '/api/catalog/artist', async (route) => {
      await artistGate.wait();
      await route.fulfill({
        json: {
          name: 'Docked Artist',
          resolved: true,
          deezer_id: '77',
          in_library: false,
          metadata: { nb_fans: 5000 },
          top_tracks: [{ id: 'deezer:t1', type: 'track', source: 'deezer', title: 'Docked Track', artist: 'Docked Artist', duration: 200 }],
          albums: [{ deezer_id: 'a1', title: 'Docked Album', cover: ARTWORK_SVG(40), year: 2024 }],
          singles_eps: [],
          related_artists: [],
          candidates: [],
        },
      });
    });
    await openMusicPlayer(page);
    const dockSurface = page.locator('[data-player-surface-open]');
    await expect(dockSurface).toHaveAttribute('data-docked', '');
    await page.evaluate(() => {
      location.hash = '#/artist/Docked%20Artist?deezer_id=77';
    });

    const dockedSkel = page.locator('[data-primary-scroll] [data-skeleton-row]').first();
    await expect(dockedSkel).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const dockBox = await measureBox(dockSurface);
    const dockedSkelBox = await measureBox(dockedSkel);
    expect(dockedSkelBox.right).toBeLessThanOrEqual(dockBox.left + 2);

    artistGate.release();
    const dockedLoaded = page.locator('[data-song-row], [data-catalog-row]').first();
    await expect(dockedLoaded).toBeVisible();
    await settleFrames(page);
    expectBoxClose(dockedSkelBox, await measureBox(dockedLoaded), ['left', 'width'], 2);
  });

  test('album, artist, bookmark and discovery card grids and rails align with loaded cards', async ({ page, isMobile }) => {
    await mockMusicEngine(page);
    const libGate = createGate();
    const savedGate = createGate();
    const feedGate = createGate();

    const richTracks = [
      { id: 't1', title: 'Song One', artist: 'Alpha Artist', album: 'First Record', album_id: 'alb-1', duration: 190 },
      { id: 't2', title: 'Song Two', artist: 'Beta Artist', album: 'Second Record', album_id: 'alb-2', duration: 210 },
    ];

    await page.route((url) => url.pathname === '/api/library', async (route) => {
      await libGate.wait();
      await route.fulfill({ json: { tracks: richTracks, playlists: {}, settings: {}, podcast_subscriptions: [] } });
    });
    await page.route((url) => url.pathname === '/api/library/artists', async (route) => {
      await libGate.wait();
      await route.fulfill({
        json: {
          artists: [
            { id: 'art-1', name: 'Alpha Artist', track_count: 1, album_count: 1, cover_track_id: 't1' },
            { id: 'art-2', name: 'Beta Artist', track_count: 1, album_count: 1, cover_track_id: 't2' },
          ],
        },
      });
    });
    await page.route((url) => url.pathname === '/api/library/albums', async (route) => {
      await libGate.wait();
      await route.fulfill({
        json: {
          albums: [
            { id: 'alb-1', title: 'First Record', artist: 'Alpha Artist', artists: [{ id: 'art-1', name: 'Alpha Artist' }], cover_track_id: 't1', track_count: 1 },
            { id: 'alb-2', title: 'Second Record', artist: 'Beta Artist', artists: [{ id: 'art-2', name: 'Beta Artist' }], cover_track_id: 't2', track_count: 1 },
          ],
          sort: 'recent',
        },
      });
    });
    await page.route((url) => url.pathname === '/api/library/saved-entities', async (route) => {
      await savedGate.wait();
      await route.fulfill({
        json: {
          entities: [{ kind: 'artist', name: 'Saved Alpha', cover: ARTWORK_SVG(80), destination: '/artist/Saved%20Alpha?deezer_id=10' }],
        },
      });
    });
    let holdFeed = false;
    await page.route('**/api/discovery/music/feed**', async (route) => {
      if (holdFeed) await feedGate.wait();
      await route.fulfill({
        json: {
          browse_sections: [
            {
              id: 'artists',
              popular: false,
              items: Array.from({ length: 6 }, (_, i) => ({
                id: `art:${i}`,
                type: 'artist',
                source: 'deezer',
                title: `Artist ${i + 1}`,
                cover: ARTWORK_SVG(i * 35),
                external_ids: { deezer_artist_id: String(i + 1) },
              })),
            },
          ],
          items: [],
        },
      });
    });

    // 1. /albums (square grid)
    await page.goto('/player/#/albums');
    await expect(page.getByRole('searchbox').or(page.getByRole('button', { name: /Buscar en biblioteca/i })).first()).toBeVisible();
    const albumCards = page.locator('[data-skeleton-cards][data-shape="square"]');
    await expect(albumCards).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const firstAlbumSkel = await measureBox(albumCards.locator('> div').first());

    // Check /artists (round grid) while library is still pending
    await page.goto('/player/#/artists');
    const artistCards = page.locator('[data-skeleton-cards][data-shape="round"]');
    await expect(artistCards).toBeVisible();
    await settleFrames(page);
    const roundRadius = await artistCards.locator('> div > span').first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { radius: parseFloat(style.borderTopLeftRadius), width: el.getBoundingClientRect().width };
    });
    expect(roundRadius.radius).toBeGreaterThanOrEqual(roundRadius.width / 2 - 1);
    const firstArtistSkel = await measureBox(artistCards.locator('> div').first());

    libGate.release();
    const loadedArtistLink = page.getByRole('link', { name: /Alpha Artist/ }).first();
    await expect(loadedArtistLink).toBeVisible();
    await settleFrames(page);
    expectBoxClose(firstArtistSkel, await measureBox(loadedArtistLink), ['left', 'top', 'width'], 2);

    await page.goto('/player/#/albums');
    const loadedAlbumLink = page.getByRole('link', { name: /First Record/ }).first();
    await expect(loadedAlbumLink).toBeVisible();
    await settleFrames(page);
    expectBoxClose(firstAlbumSkel, await measureBox(loadedAlbumLink), ['left', 'top', 'width'], 2);

    // 2. /bookmarks/artists keeps heading above round cards
    await page.goto('/player/#/bookmarks/artists');
    const bmHeading = page.locator('main').getByRole('heading', { level: 2 }).first();
    const bmCards = page.locator('[data-skeleton-cards][data-shape="round"]');
    await expect(bmHeading).toBeVisible();
    await expect(bmCards).toBeVisible();
    await settleFrames(page);
    expect((await measureBox(bmHeading)).bottom).toBeLessThanOrEqual((await measureBox(bmCards)).top + 2);
    const bmCardSkel = await measureBox(bmCards.locator('> div').first());

    savedGate.release();
    const bmLoadedCard = page.locator('[data-app-outlet] article').first();
    await expect(bmLoadedCard).toBeVisible();
    await settleFrames(page);
    expectBoxClose(bmCardSkel, await measureBox(bmLoadedCard), ['left', 'top', 'width'], 2);

    // 3. /search Discover horizontal rail (single row, no document overflow)
    holdFeed = true;
    await page.goto('about:blank');
    await page.goto('/player/#/search');
    const rail = page.locator('[data-testid="search-discovery"] [data-skeleton-cards][data-layout="rail"]').first();
    await expect(rail).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const railTops = await rail.locator('> div').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    for (const top of railTops) {
      expect(Math.abs(top - railTops[0])).toBeLessThanOrEqual(1);
    }
    const firstRailSkel = await measureBox(rail.locator('> div').first());

    feedGate.release();
    const loadedDiscoveryCard = page.getByRole('link', { name: 'Artist 1', exact: true });
    await expect(loadedDiscoveryCard).toBeVisible();
    await settleFrames(page);
    const loadedDiscoveryBox = await measureBox(loadedDiscoveryCard);
    expect(Math.abs(firstRailSkel.width - loadedDiscoveryBox.width)).toBeLessThanOrEqual(2);
    if (!isMobile) {
      expect(Math.abs(firstRailSkel.left - loadedDiscoveryBox.left)).toBeLessThanOrEqual(2);
    }
  });

  test('/search?q= query TopResult + Songs split mirrors loaded layout on desktop and mobile', async ({ page, isMobile }) => {
    await mockMusicEngine(page);
    const searchGate = createGate();
    await page.route('**/api/catalog/search**', async (route) => {
      await searchGate.wait();
      await route.fulfill({
        json: {
          items: [
            { id: 'album:top', type: 'album', source: 'deezer', title: 'Halo Record', artist: 'Band', cover: ARTWORK_SVG(120) },
            { id: 'track:1', type: 'track', source: 'deezer', title: 'Halo Track', artist: 'Band', duration: 210, cover: ARTWORK_SVG(120) },
          ],
          sections: [
            { id: 'top', item_ids: ['album:top'] },
            { id: 'songs', layout: 'rows', item_ids: ['track:1'] },
          ],
        },
      });
    });

    await page.goto('/player/#/search?q=Halo');
    const topBlock = page.locator('[data-skeleton-top-block]');
    await expect(topBlock).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);

    const columns = await Promise.all([0, 1].map(i => measureBox(topBlock.locator(':scope > *').nth(i))));
    const [top, songs] = columns;
    if (isMobile) {
      expect(top.bottom).toBeLessThanOrEqual(songs.top + 2);
    } else {
      expect(top.right).toBeLessThanOrEqual(songs.left + 2);
      expect(Math.abs(top.top - songs.top)).toBeLessThanOrEqual(2);
    }

    searchGate.release();
    await expect(page.getByRole('heading', { name: 'Mejor resultado', exact: true })).toBeVisible();
    const loaded = page.locator('[data-search-top-block] > section');
    for (const [i, column] of columns.entries()) {
      expectBoxClose(column, await measureBox(loaded.nth(i)), ['left', 'width']);
    }
  });

  test('downloads, podcasts, settings and entity detail skeletons match target geometry', async ({ page, isMobile }) => {
    await mockMusicEngine(page);
    const dlGate = createGate();
    const settingsGate = createGate();
    const usersGate = createGate();
    const podSearchGate = createGate();
    const podShowGate = createGate();
    const artistGate = createGate();
    const albumGate = createGate();

    const show = {
      id: 'show-1',
      title: 'Soundsible Show',
      author: 'Host',
      rss_url: 'https://feeds.example.test/show.xml',
      image_url: null,
    };

    await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({
      json: { tracks: SAMPLE_TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [show] },
    }));
    await page.route((url) => url.pathname === '/api/downloader/queue' || url.pathname === '/api/downloader/queue/status', async (route) => {
      await dlGate.wait();
      await route.fulfill({
        json: {
          queue: [{ id: 'dl-1', status: 'downloading', display_title: 'Downloading One', title: 'Downloading One', artist: 'Artist' }],
          is_processing: true,
          logs: [],
        },
      });
    });
    await page.route((url) => url.pathname === '/api/discovery/settings', async (route) => {
      await settingsGate.wait();
      await route.fulfill({ json: { learning_enabled: true, autoplay_enabled: false } });
    });
    await page.route((url) => url.pathname === '/api/users', async (route) => {
      await usersGate.wait();
      await route.fulfill({
        json: {
          requires_login: true,
          users: [{ id: 'qa', username: 'qa', display_name: 'QA User', role: 'admin', has_password: true }],
        },
      });
    });
    await page.route('**/api/discovery/podcasts/top**', (route) => route.fulfill({ json: { country: 'us', results: [] } }));
    await page.route('**/api/discovery/podcasts/search**', async (route) => {
      await podSearchGate.wait();
      await route.fulfill({ json: { results: [{ title: 'Found Show', author: 'Someone', feed_url: 'https://feeds.example.test/found.xml' }] } });
    });
    await page.route('**/api/podcasts/feeds/**', async (route) => {
      await podShowGate.wait();
      await route.fulfill({
        json: {
          subscription: show,
          episodes: [{ guid: 'ep-1', title: 'Episode One', enclosure_url: 'https://cdn.example.test/ep1.mp3', duration_sec: 600 }],
        },
      });
    });
    await page.route((url) => url.pathname === '/api/catalog/artist', async (route) => {
      await artistGate.wait();
      await route.fulfill({
        json: {
          name: 'Josh Woodward',
          resolved: true,
          deezer_id: '1',
          in_library: false,
          metadata: { nb_fans: 12000 },
          top_tracks: [{ id: 'deezer:tr:1', type: 'track', source: 'deezer', title: 'Track One', artist: 'Josh Woodward', duration: 180 }],
          albums: [],
          singles_eps: [],
          related_artists: [],
          candidates: [],
        },
      });
    });
    await page.route((url) => url.pathname === '/api/catalog/album', async (route) => {
      await albumGate.wait();
      await route.fulfill({
        json: {
          title: 'Ashes',
          artist: 'Josh Woodward',
          resolved: true,
          deezer_id: '2',
          year: 2010,
          in_library: false,
          cover: ARTWORK_SVG(200),
          tracklist: [{ id: 'deezer:tr:2', type: 'track', source: 'deezer', title: 'Ashes Track', artist: 'Josh Woodward', album: 'Ashes', duration: 195 }],
        },
      });
    });

    // 1. /downloads
    await page.goto('/player/#/downloads');
    const dlSkel = page.locator('[data-primary-scroll] [data-variant="download"] [data-skeleton-row]').first();
    await expect(dlSkel).toBeVisible();
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const dlSkelBox = await measureBox(dlSkel);
    expect(dlSkelBox.width).toBeLessThanOrEqual(722);
    dlGate.release();
    const dlLoaded = page.getByText('Downloading One', { exact: true });
    await expect(dlLoaded).toBeVisible();
    await settleFrames(page);
    const dlLoadedRow = await dlLoaded.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      while (node && node !== document.body) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') break;
        node = node.parentElement;
      }
      return (node ?? el).getBoundingClientRect();
    });
    expect(Math.abs(dlSkelBox.left - dlLoadedRow.left)).toBeLessThanOrEqual(8);

    // 2. /settings/playback (no track cover bones!)
    await page.goto('/player/#/settings/playback');
    const settingRows = page.locator('[data-settings-page] [aria-busy="true"] [data-variant="setting"] [data-skeleton-row]');
    await expect(settingRows.first()).toBeVisible();
    expect(await page.locator('[data-settings-page] [data-variant="setting"] [data-skeleton-cover]').count()).toBe(0);
    await settleFrames(page);
    await expectNoHorizontalOverflow(page);
    const settingSkelBox = await measureBox(settingRows.first());
    settingsGate.release();
    const loadedSetting = page.locator('[data-settings-page] [data-setting]').first();
    await expect(loadedSetting).toBeVisible();
    await settleFrames(page);
    const loadedSettingBox = await measureBox(loadedSetting);
    expect(Math.abs(settingSkelBox.left - loadedSettingBox.left)).toBeLessThanOrEqual(4);
    expect(Math.abs(settingSkelBox.width - loadedSettingBox.width)).toBeLessThanOrEqual(4);

    // 3. /settings/users
    await page.goto('/player/#/settings/users');
    const userAvatar = page.locator('[data-settings-page] [data-variant="user"] [data-skeleton-cover]').first();
    await expect(userAvatar).toBeVisible();
    await expectNoHorizontalOverflow(page);
    usersGate.release();

    // 4. /podcasts search & /podcasts/show-1
    await page.goto('/player/#/podcasts');
    const searchField = page.getByRole('searchbox');
    const searchButton = page.getByRole('button', { name: /Buscar/i }).first();
    await expect(searchField.or(searchButton)).toBeVisible();
    if (!(await searchField.isVisible())) {
      await searchButton.click();
    }
    await searchField.fill('science');
    const podSearchSkel = page.locator('[data-variant="media"] [data-skeleton-row]').first();
    await expect(podSearchSkel).toBeVisible();
    await settleFrames(page);
    const podSearchBox = await measureBox(podSearchSkel);
    podSearchGate.release();
    const loadedPodRow = page.locator('[data-music-list-row]').first();
    await expect(loadedPodRow).toBeVisible();
    await settleFrames(page);
    expectBoxClose(podSearchBox, await measureBox(loadedPodRow), ['left', 'width'], 4);

    await page.goto('/player/#/podcasts/show-1');
    const epSkel = page.locator(`[data-primary-scroll] [data-variant="${isMobile ? 'media' : 'episode'}"] [data-skeleton-row]`).first();
    await expect(epSkel).toBeVisible();
    await settleFrames(page);
    const epSkelBox = await measureBox(epSkel);
    podShowGate.release();
    const epLoaded = page.locator(isMobile ? '[data-music-list-row]' : '[aria-label^="Reproducir episodio:"]').first();
    await expect(epLoaded).toBeVisible();
    await settleFrames(page);
    expectBoxClose(epSkelBox, await measureBox(epLoaded), ['left', 'top', 'width'], 4);

    // 5. /artist & /album discover routes
    await page.goto('/player/#/artist/Josh%20Woodward?deezer_id=1');
    const artistSkelRow = page.locator('[data-primary-scroll] [data-variant="song"] [data-skeleton-row]').first();
    await expect(artistSkelRow).toBeVisible();
    await settleFrames(page);
    const artistSkelBox = await measureBox(artistSkelRow);
    artistGate.release();
    const artistLoaded = page.locator(isMobile ? '[data-music-list-row]' : '[data-song-row], [data-catalog-row]').first();
    await expect(artistLoaded).toBeVisible();
    await settleFrames(page);
    expectBoxClose(artistSkelBox, await measureBox(artistLoaded), ['left', 'width'], 4);

    await page.goto('/player/#/album/Ashes?artist=Josh%20Woodward&deezer_id=2');
    const albumSkelRow = page.locator('[data-primary-scroll] [data-variant="song"] [data-skeleton-row]').first();
    await expect(albumSkelRow).toBeVisible();
    await settleFrames(page);
    const albumSkelBox = await measureBox(albumSkelRow);
    albumGate.release();
    const albumLoaded = page.locator(isMobile ? '[data-music-list-row]' : '[data-song-row], [data-catalog-row]').first();
    await expect(albumLoaded).toBeVisible();
    await settleFrames(page);
    expectBoxClose(albumSkelBox, await measureBox(albumLoaded), ['left', 'top', 'width'], 4);
  });

  test('themes apply distinct skeleton tones and loading states pass WCAG 2 AA axe checks', async ({ page }) => {
    await mockMusicEngine(page);
    const libGate = createGate();
    await page.route((url) => url.pathname === '/api/library', async (route) => {
      await libGate.wait();
      await route.fulfill({ json: { tracks: SAMPLE_TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] } });
    });

    const tones: Record<string, string> = {};
    for (const [name, theme, hc] of [
      ['dark', 'dark', 'false'],
      ['light', 'light', 'false'],
      ['high-contrast', 'dark', 'true'],
    ] as const) {
      await page.addInitScript(
        ([chosenTheme, contrastFlag]) => {
          localStorage.setItem('theme', chosenTheme);
          localStorage.setItem('soundsible:high-contrast', contrastFlag);
        },
        [theme, hc] as const,
      );
      await page.goto('about:blank');
      await page.goto('/player/#/favourites');
      const coverBone = page.locator('[data-library-scroll] [data-skeleton-row] [data-skeleton-cover]').first();
      await expect(coverBone).toBeVisible();
      await settleFrames(page);
      tones[name] = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--skeleton-base').trim());
      expect(tones[name]).not.toBe('');
      if (name === 'dark' || name === 'light') {
        const results = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa']).analyze();
        expect(results.violations).toEqual([]);
      }
    }

    expect(tones.dark).not.toBe(tones.light);
    expect(tones.dark).not.toBe(tones['high-contrast']);
    libGate.release();
  });
});
