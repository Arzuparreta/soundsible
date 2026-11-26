import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine, openMusicPlayer } from './music-browser-fixture';

const artwork = (index: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="hsl(${index * 37},30%,28%)"/><circle cx="160" cy="135" r="75" fill="hsl(${index * 37},35%,55%)"/><path d="M0 280L160 180 320 280V320H0" fill="hsl(${index * 37},30%,15%)"/></svg>`)}`;
const sections = [
  { id: 'artists', popular: false, items: Array.from({ length: 10 }, (_, index) => ({
    id: `artist:${index}`, type: 'artist', source: 'deezer', title: `Artista recomendado ${index + 1}`,
    cover: artwork(index), reason_artist: 'Extremoduro', external_ids: { deezer_artist_id: String(index + 1) },
  })) },
  { id: 'albums', popular: false, items: Array.from({ length: 10 }, (_, index) => ({
    id: `album:${index}`, type: 'album', source: 'deezer', title: `Un disco por descubrir ${index + 1}`, artist: `Artista ${index + 1}`,
    cover: artwork(index + 8), external_ids: { deezer_album_id: String(index + 20), deezer_artist_id: String(index + 1) },
  })) },
];
const items = Array.from({ length: 10 }, (_, index) => ({ id: `song:${index}`, track_id: `library-track-${index + 1}`,
  title: `Canción recomendada ${index + 1}`, artist: `Artista ${index + 1}`, cover: artwork(index + 3) }));

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/discovery/music/feed?**', (route) => route.fulfill({ json: { browse_sections: sections, items } }));
});

test('search uses the available column when songs have no neighbor or the player docks', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'desktop player dock');
  await page.setViewportSize({ width: 1366, height: 768 });
  const song = { id: 'song:result', type: 'track', source: 'youtube', title: 'Corazón de acero', artist: 'Chiquetete', duration: 172, cover: artwork(2) };
  const album = { id: 'album:result', type: 'album', source: 'deezer', title: 'Con permiso', artist: 'Chiquetete', cover: artwork(3) };
  await page.route('**/api/catalog/search?**', (route) => {
    const withTop = new URL(route.request().url()).searchParams.get('q')?.includes('original');
    const songs = { id: 'songs', layout: 'rows', item_ids: [song.id] };
    return route.fulfill({ json: {
      items: withTop ? [album, song] : [song],
      sections: withTop ? [{ id: 'top', item_ids: [album.id] }, songs] : [songs],
    } });
  });
  await openMusicPlayer(page);
  await page.goto('/player/#/search?q=corazon');
  const surface = page.locator('[data-player-surface-open]');
  await expect(surface).toHaveAttribute('data-docked', '');
  const songs = page.getByRole('heading', { name: 'Canciones', exact: true }).locator('..');
  const field = page.getByRole('searchbox');
  await expect(songs).toBeVisible();
  await page.screenshot({ path: info.outputPath('search-docked.png') });
  await expect(songs.getByText(song.title, { exact: true })).toBeVisible();
  const width = async () => (await songs.boundingBox())!.width / (await field.boundingBox())!.width;
  await expect.poll(width).toBeGreaterThan(0.95);

  await field.fill('corazon original');
  const top = page.getByRole('heading', { name: 'Mejor resultado', exact: true });
  await expect(top).toBeVisible();
  await expect.poll(width).toBeGreaterThan(0.95);
  await surface.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect.poll(width).toBeLessThan(0.75);
  expect((await songs.boundingBox())!.y).toBeCloseTo((await top.boundingBox())!.y, 0);

  await field.fill('corazon');
  await expect(top).toHaveCount(0);
  await expect.poll(width).toBeGreaterThan(0.95);
});

test('home has distinct entities, bounded songs, working sections and restoration', async ({ page }, info) => {
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  const artists = home.getByRole('region', { name: 'Artistas por descubrir' });
  const albums = home.getByRole('region', { name: 'Álbumes para ti' });
  await expect(artists).toBeVisible();
  await expect(albums).toBeVisible();
  await expect(artists.getByText('Similar a Extremoduro').first()).toBeVisible();
  await expect(home.getByText(/^Canción recomendada /)).toHaveCount(5);
  await expect(page.getByRole('searchbox')).not.toBeFocused();
  const artist = artists.getByRole('link', { name: 'Artista recomendado 1', exact: true });
  await expect(artist).toHaveAttribute('href', /deezer_id=1/);
  const album = albums.getByRole('link', { name: 'Un disco por descubrir 1', exact: true });
  await expect(album).toHaveAttribute('href', /deezer_id=20/);
  const round = async (element: typeof artist) => element.locator('span').first().evaluate(el => {
    const radius = getComputedStyle(el).borderRadius;
    return radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= el.getBoundingClientRect().width / 2;
  });
  expect(await round(artist)).toBe(true);
  expect(await round(album)).toBe(false);
  await page.screenshot({ path: info.outputPath('search-home.png') });
  const scroll = page.locator('[data-primary-scroll]').first();
  await scroll.evaluate(el => { el.scrollTop = 160; });
  const offset = await scroll.evaluate(el => el.scrollTop);
  await albums.getByRole('link', { name: 'Ver todos: Álbumes para ti' }).click();
  await expect(page).toHaveURL(/browse=albums/);
  await expect(home.getByRole('link', { name: /^Un disco por descubrir / })).toHaveCount(10);
  await expect(home.getByRole('heading', { name: 'Álbumes para ti' })).toBeFocused();
  await expect(home.getByRole('region', { name: 'Artistas por descubrir' })).toHaveCount(0);
  await home.getByRole('button', { name: 'Volver a Descubrir' }).click();
  await expect(artists).toBeVisible();
  await expect(albums.getByRole('link', { name: 'Ver todos: Álbumes para ti' })).toBeFocused();
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(offset, -1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('entity navigation returns to the same recommendations', async ({ page }) => {
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  await home.getByRole('link', { name: 'Artista recomendado 1', exact: true }).click();
  await expect(page).toHaveURL(/artist/);
  await page.goBack();
  await expect(home.getByRole('link', { name: 'Artista recomendado 1', exact: true })).toBeVisible();
  await home.getByRole('link', { name: 'Un disco por descubrir 1', exact: true }).click();
  await expect(page).toHaveURL(/album/);
  await page.goBack();
  await expect(home.getByRole('link', { name: 'Un disco por descubrir 1', exact: true })).toBeVisible();
});

test('Discover arrives on the feed and searches only when asked', async ({ page }) => {
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  const field = page.getByRole('searchbox');
  const album = home.getByRole('link', { name: 'Un disco por descubrir 1', exact: true });
  await expect(album).toBeVisible();
  await expect(field).not.toBeFocused();
  await expect(page.getByText('Búsquedas recientes')).toHaveCount(0);
  await album.click();
  await expect(page).toHaveURL(/album/);
  await page.goBack();
  await expect(album).toBeVisible();
  await expect(field).not.toBeFocused();
  // "/" from anywhere returns to Discover's search with the cursor in it, and
  // the key itself is not typed.
  await album.click();
  await expect(page).toHaveURL(/album/);
  await page.keyboard.press('/');
  await expect(page).toHaveURL(/#\/search$/);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
});

test('360px layout keeps horizontal exploration inside the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  await expect(home.getByRole('heading', { name: 'Artistas por descubrir' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('search-home-360.png') });
});

test('keyboard exploration and song playback retain their own actions', async ({ page }, info) => {
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  const artist = home.getByRole('link', { name: 'Artista recomendado 1', exact: true });
  await artist.focus();
  await expect(artist).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/artist/);
  await page.goBack();
  await home.getByRole('link', { name: 'Ver todos: Canciones que te pueden gustar' }).click();
  await expect(home.getByText(/^Canción recomendada /)).toHaveCount(10);
  await home.getByRole('button', { name: 'Canción recomendada 1 — Artista 1' }).or(home.getByRole('button', { name: /^Canción recomendada 1(?: —|$)/ })).click();
  await expect(page.locator('[data-omni-player]')).toContainText('Canción de biblioteca 1');
  await home.getByRole('button', { name: 'Más opciones: Canción recomendada 1', exact: true }).click();
  const menu = page.getByRole(info.project.name.includes('mobile') ? 'dialog' : 'menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
});


test('discovery home exposes accessible section and navigation controls', async ({ page }) => {
  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Artistas por descubrir' })).toBeVisible();
  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});

test('renders structured backend shelves with localized reasons and expands dynamic shelves cleanly', async ({ page }) => {
  await page.route('**/api/discovery/music/feed?**', (route) => route.fulfill({
    json: {
      browse_sections: sections,
      sections: [
        {
          id: 'because_you_listen_extremoduro',
          title: 'More like Extremoduro',
          title_key: 'more_like',
          title_params: { artist: 'Extremoduro' },
          reason: 'Similar artists to Extremoduro based on your listening and library.',
          reason_key: 'because_listen',
          reason_params: { artist: 'Extremoduro' },
          item_ids: Array.from({ length: 7 }, (_, i) => `deezer:${300 + i}`),
        },
        {
          id: 'explore_from_seed',
          title: 'Explore from Jesucristo García',
          title_key: 'explore_from',
          title_params: { title: 'Jesucristo García' },
          reason_key: 'explore_connections',
          item_ids: ['youtube:vid01'],
        },
      ],
      items: [
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `deezer:${300 + i}`,
          title: `Tema similar ${i + 1}`,
          artist: `Banda relacionada ${i + 1}`,
          cover: artwork(i + 2),
          duration: 210,
        })),
        { id: 'youtube:vid01', title: 'Conexión directa', artist: 'Marea', external_ids: { youtube_id: 'vid00000001' }, cover: artwork(6) },
      ],
    },
  }));

  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');

  const moreLike = home.getByRole('region', { name: 'Más como Extremoduro' });
  await expect(moreLike).toBeVisible();
  await expect(moreLike.getByText('Artistas similares según lo que escuchas')).toBeVisible();
  await expect(moreLike.getByText(/^Tema similar /)).toHaveCount(5);

  const exploreFrom = home.getByRole('region', { name: 'Explorar desde Jesucristo García' });
  await expect(exploreFrom).toBeVisible();
  await expect(exploreFrom.getByText('Conexiones de tu grafo musical')).toBeVisible();

  const scroll = page.locator('[data-primary-scroll]').first();
  const moreLink = moreLike.getByRole('link', { name: 'Ver todos: Más como Extremoduro' });
  await moreLink.scrollIntoViewIfNeeded();
  const offset = await scroll.evaluate(el => el.scrollTop);
  await moreLink.click();

  await expect(page).toHaveURL(/browse=because_you_listen_extremoduro/);
  await expect(home.getByRole('heading', { name: 'Más como Extremoduro' })).toBeFocused();
  await expect(home.getByText(/^Tema similar /)).toHaveCount(7);
  await expect(home.getByRole('region', { name: 'Explorar desde Jesucristo García' })).toHaveCount(0);

  await home.getByRole('button', { name: 'Volver a Descubrir' }).click();
  await expect(exploreFrom).toBeVisible();
  await expect(moreLike.getByRole('link', { name: 'Ver todos: Más como Extremoduro' })).toBeFocused();
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(offset, -1);

  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});

test('refresh control triggers rotation request and labels singles and EPs', async ({ page }) => {
  const urls: string[] = [];
  let refreshed = false;
  await page.route('**/api/discovery/music/feed?**', (route) => {
    const url = route.request().url();
    urls.push(url);
    if (url.includes('refresh=1')) refreshed = true;
    return route.fulfill({
      json: {
        browse_sections: [
          {
            id: 'albums',
            popular: false,
            items: [
              {
                id: 'album:single',
                type: 'album',
                source: 'deezer',
                title: refreshed ? 'Nuevo sencillo' : 'Primer sencillo',
                artist: 'Marea',
                record_type: 'single',
                cover: artwork(1),
                external_ids: { deezer_album_id: '201', deezer_artist_id: '1' },
              },
              {
                id: 'album:ep',
                type: 'album',
                source: 'deezer',
                title: 'Sesión EP',
                artist: 'Extremoduro',
                record_type: 'ep',
                cover: artwork(2),
                external_ids: { deezer_album_id: '202', deezer_artist_id: '2' },
              },
            ],
          },
        ],
        sections: [
          {
            id: 'because_you_listen_marea',
            title: 'More like Marea',
            title_key: 'more_like',
            title_params: { artist: 'Marea' },
            reason_key: 'because_listen',
            reason_params: { artist: 'Marea' },
            item_ids: ['deezer:501'],
          },
        ],
        items: [
          {
            id: 'deezer:501',
            title: refreshed ? 'Tema rotado' : 'Tema inicial',
            artist: 'Platero y Tú',
            cover: artwork(3),
            duration: 210,
          },
        ],
      },
    });
  });

  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  await expect(home.getByText('Marea · Sencillo')).toBeVisible();
  await expect(home.getByText('Extremoduro · EP')).toBeVisible();
  await expect(home.getByText('Tema inicial')).toBeVisible();
  await expect(home.getByRole('button', { name: 'Actualizar' })).toHaveCount(0);

  const isMobile = test.info().project.name.includes('mobile');
  const headerScope = page.locator(isMobile ? '[data-app-bar]' : '[data-app-outlet]');
  const refresh = headerScope.getByRole('button', { name: 'Actualizar' });
  await expect(refresh).toBeVisible();
  await expect(headerScope.getByRole('heading', { level: 1 })).toHaveCount(isMobile ? 1 : 0);
  await expect(page.getByRole('heading', { name: 'Descubrir', level: 1 })).toBeVisible();
  await expect(page.locator('[data-page-indicator]')).toHaveCount(isMobile ? 0 : 1);

  await refresh.click();
  await expect(home.getByText('Nuevo sencillo')).toBeVisible();
  await expect(home.getByText('Tema rotado')).toBeVisible();
  expect(urls.some(u => u.includes('refresh=1'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const audit = await new AxeBuilder({ page }).include('main').analyze();
  expect(audit.violations).toEqual([]);
});

test('unresolved Deezer Discover rows expose reason, immediate dismissal with Undo, and Start Radio', async ({ page }, info) => {
  const feedbackPayloads: Array<Record<string, unknown>> = [];
  let undoCount = 0;
  let resolveCount = 0;
  let radioPlanned = 0;

  await page.route('**/api/discovery/feedback', async (route) => {
    feedbackPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { recorded: true, event_id: 'ev-deezer-300' } });
  });
  await page.route('**/api/discovery/feedback/ev-deezer-300', async (route) => {
    if (route.request().method() === 'DELETE') undoCount += 1;
    await route.fulfill({ json: { undone: true } });
  });
  await page.route('**/api/catalog/resolve', async (route) => {
    resolveCount += 1;
    await route.fulfill({ json: { video_id: 'rad11111111', title: 'Canción Deezer', artist: 'Platero y Tú' } });
  });
  await page.route('**/api/discovery/music/plan', async (route) => {
    radioPlanned += 1;
    await route.fulfill({
      json: {
        items: [{ id: 'mix-1', title: 'Tema de radio', artist: 'Marea', video_id: 'mix11111111', duration: 200 }],
        plan: {},
        transitions: [],
      },
    });
  });
  await page.route('**/api/discovery/music/feed?**', (route) =>
    route.fulfill({
      json: {
        sections: [
          {
            id: 'more_like_extremoduro',
            title: 'More like Extremoduro',
            title_key: 'more_like',
            title_params: { artist: 'Extremoduro' },
            item_ids: ['deezer:300', 'deezer:301'],
          },
        ],
        items: [
          {
            id: 'deezer:300',
            title: 'Canción Deezer',
            artist: 'Platero y Tú',
            source: 'deezer',
            cover: artwork(1),
            duration: 215,
            external_ids: { deezer_id: '300', isrc: 'ES12345' },
            recommendation_identity: 'music:deezer:300',
            reason: 'Conexión de tu grafo musical',
            reason_code: 'library_graph',
          },
          {
            id: 'deezer:301',
            title: 'Canción vecina',
            artist: 'Fito & Fitipaldis',
            source: 'deezer',
            cover: artwork(2),
            duration: 205,
            external_ids: { deezer_id: '301' },
            recommendation_identity: 'music:deezer:301',
            reason: 'Conexión de tu grafo musical',
            reason_code: 'library_graph',
          },
        ],
      },
    }),
  );

  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  const firstRowTitle = home.getByText('Canción Deezer', { exact: true });
  await expect(firstRowTitle).toBeVisible();

  const itemRole = info.project.name.includes('mobile') ? 'button' : 'menuitem';
  const menuContainerRole = info.project.name.includes('mobile') ? 'dialog' : 'menu';

  await home.getByRole('button', { name: 'Más opciones: Canción Deezer', exact: true }).click();
  const menu = page.getByRole(menuContainerRole);
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Conexión de tu grafo musical')).toBeVisible();
  await expect(menu.getByRole(itemRole, { name: 'Iniciar radio' })).toBeVisible();
  await menu.getByRole(itemRole, { name: 'No me interesa' }).click();

  await expect(firstRowTitle).toHaveCount(0);
  expect(feedbackPayloads).toHaveLength(1);
  expect(feedbackPayloads[0]).toMatchObject({
    feedback: 'not_interested',
    item: {
      media_type: 'music_track',
      deezer_id: '300',
      isrc: 'ES12345',
      title: 'Canción Deezer',
      artist: 'Platero y Tú',
    },
  });

  await page.getByRole('button', { name: 'Deshacer' }).click();
  await expect(firstRowTitle).toBeVisible();
  expect(undoCount).toBe(1);

  await home.getByRole('button', { name: 'Más opciones: Canción Deezer', exact: true }).click();
  const reopened = page.getByRole(menuContainerRole);
  const preRadioResolveCount = resolveCount;
  await reopened.getByRole(itemRole, { name: 'Iniciar radio' }).click();
  await expect.poll(() => resolveCount - preRadioResolveCount).toBe(1);
  await expect.poll(() => radioPlanned).toBeGreaterThanOrEqual(1);

  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});

test('renders release_radar rail with New badge, attribution, formatted date, and expansion', async ({ page }) => {
  await page.route('**/api/discovery/music/feed?**', (route) =>
    route.fulfill({
      json: {
        needs_seed: false,
        browse_sections: [
          {
            id: 'release_radar',
            popular: false,
            items: [
              {
                id: 'deezer:album:901',
                type: 'album',
                source: 'deezer',
                title: 'Estreno reciente',
                artist: 'Marea',
                record_type: 'ep',
                release_date: '2026-11-18',
                is_new: true,
                reason_artist: 'Extremoduro',
                cover: artwork(1),
                external_ids: { deezer_album_id: '901', deezer_artist_id: '1' },
              },
              {
                id: 'deezer:album:902',
                type: 'album',
                source: 'deezer',
                title: 'Lanzamiento previo',
                artist: 'Platero y Tú',
                record_type: 'album',
                release_date: '2026-10-15',
                is_new: false,
                reason_artist: 'Extremoduro',
                cover: artwork(2),
                external_ids: { deezer_album_id: '902', deezer_artist_id: '2' },
              },
              {
                id: 'deezer:album:903',
                type: 'album',
                source: 'deezer',
                title: 'Tercer lanzamiento',
                artist: 'Robe',
                record_type: 'single',
                release_date: '2026-10-10',
                is_new: false,
                cover: artwork(3),
                external_ids: { deezer_album_id: '903', deezer_artist_id: '3' },
              },
            ],
          },
          {
            id: 'artists',
            popular: false,
            items: [
              { id: 'deezer:artist:4', type: 'artist', source: 'deezer', title: 'Platero y Tú', cover: artwork(4), reason_artist: 'Extremoduro', external_ids: { deezer_artist_id: '4' } },
            ],
          },
        ],
        sections: [],
        items: [],
      },
    }),
  );

  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  const radar = home.getByRole('region', { name: 'Radar de novedades' });
  await expect(radar).toBeVisible();
  await expect(radar.getByText('Nuevo', { exact: true })).toHaveCount(1);
  await expect(radar.getByText(/Marea · EP · /)).toBeVisible();
  await expect(radar.getByText(/Robe · Sencillo · /)).toBeVisible();
  await expect(radar.getByText('Similar a Extremoduro')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await radar.getByRole('link', { name: 'Ver todos: Radar de novedades' }).click();
  await expect(page).toHaveURL(/browse=release_radar/);
  await expect(home.getByRole('heading', { name: 'Radar de novedades' })).toBeFocused();
  await expect(home.getByRole('region', { name: 'Artistas por descubrir' })).toHaveCount(0);

  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});

test('renders Home New Releases rail lazily on Library root with expand toggle and a11y', async ({ page }) => {
  await page.route('**/api/discovery/music/new-releases?**', (route) =>
    route.fulfill({
      json: {
        generated_at: 1795000000,
        revalidating: false,
        items: [
          {
            id: 'deezer:album:801',
            type: 'album',
            source: 'deezer',
            title: 'Nuevo disco propio',
            artist: 'Marea',
            record_type: 'ep',
            release_date: '2026-11-18',
            is_new: true,
            cover: artwork(1),
            external_ids: { deezer_album_id: '801', deezer_artist_id: '1' },
          },
          {
            id: 'deezer:album:802',
            type: 'album',
            source: 'deezer',
            title: 'Segundo disco',
            artist: 'Extremoduro',
            record_type: 'album',
            release_date: '2026-09-10',
            is_new: false,
            cover: artwork(2),
            external_ids: { deezer_album_id: '802', deezer_artist_id: '2' },
          },
          {
            id: 'deezer:album:803',
            type: 'album',
            source: 'deezer',
            title: 'Tercer sencillo',
            artist: 'Robe',
            record_type: 'single',
            release_date: '2026-08-05',
            is_new: false,
            cover: artwork(3),
            external_ids: { deezer_album_id: '803', deezer_artist_id: '3' },
          },
        ],
      },
    }),
  );

  await page.goto('/player/#/');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const homeReleases = page.getByRole('region', { name: 'Novedades' });
  await expect(homeReleases).toBeVisible();
  await expect(homeReleases.getByText('Nuevo', { exact: true })).toHaveCount(1);
  await expect(homeReleases.getByText(/Marea · EP · /)).toBeVisible();
  await expect(homeReleases.getByText(/Robe · Sencillo · /)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await homeReleases.getByRole('button', { name: 'Ver todos: Novedades' }).click();
  await expect(homeReleases.getByRole('button', { name: 'Ver menos: Novedades' })).toHaveAttribute('aria-expanded', 'true');

  const audit = await new AxeBuilder({ page }).include('main').analyze();
  expect(audit.violations).toEqual([]);
});

test('shows subtle passive cold-start hint when Discover has only popular charts', async ({ page }) => {
  await page.route('**/api/discovery/music/feed?**', (route) =>
    route.fulfill({
      json: {
        needs_seed: true,
        browse_sections: [
          {
            id: 'artists',
            popular: true,
            items: [
              { id: 'deezer:artist:10', type: 'artist', source: 'deezer', title: 'Artista popular', cover: artwork(1), external_ids: { deezer_artist_id: '10' } },
            ],
          },
        ],
        sections: [],
        items: [],
      },
    }),
  );

  await page.goto('/player/#/search');
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const home = page.getByTestId('search-discovery');
  await expect(home.getByRole('note')).toContainText('Descubrir se adapta automáticamente');

  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});
