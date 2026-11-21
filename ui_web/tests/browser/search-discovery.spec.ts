import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine } from './music-browser-fixture';

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
  await home.getByRole('button', { name: /^Canción recomendada 1(?: —|$)/ }).click();
  await expect(page.locator('[data-omni-player]')).toContainText('Canción de biblioteca 1');
  if (info.project.name.includes('mobile')) {
    await home.getByRole('button', { name: 'Más opciones: Canción recomendada 1', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }
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
          id: 'rediscover',
          title: 'Rediscover',
          title_key: 'rediscover',
          reason: "Tracks in your library you haven't played in a while.",
          reason_key: 'rediscover',
          item_ids: ['music:library-track-1', 'music:library-track-2'],
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
        { id: 'music:library-track-1', track_id: 'library-track-1', title: 'Joya olvidada 1', artist: 'Artista 1', cover: artwork(4) },
        { id: 'music:library-track-2', track_id: 'library-track-2', title: 'Joya olvidada 2', artist: 'Artista 2', cover: artwork(5) },
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

  const rediscover = home.getByRole('region', { name: 'Redescubrir' });
  await expect(rediscover).toBeVisible();
  await expect(rediscover.getByText('Temas de tu biblioteca que hace tiempo que no escuchas')).toBeVisible();

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
  await expect(home.getByRole('region', { name: 'Redescubrir' })).toHaveCount(0);

  await home.getByRole('button', { name: 'Volver a Descubrir' }).click();
  await expect(rediscover).toBeVisible();
  await expect(moreLike.getByRole('link', { name: 'Ver todos: Más como Extremoduro' })).toBeFocused();
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(offset, -1);

  const audit = await new AxeBuilder({ page }).include('[data-testid="search-discovery"]').analyze();
  expect(audit.violations).toEqual([]);
});
