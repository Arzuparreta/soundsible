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
  await expect(home.getByText(/^Canción recomendada /)).toHaveCount(5);
  if (info.project.name.includes('mobile')) await expect(page.getByRole('searchbox')).not.toBeFocused();
  const artist = artists.getByRole('link', { name: 'Artista recomendado 1', exact: true });
  await expect(artist).toHaveAttribute('href', /deezer_id=1/);
  const album = albums.getByRole('link', { name: 'Un disco por descubrir 1', exact: true });
  await expect(album).toHaveAttribute('href', /deezer_id=20/);
  expect(await artist.locator('span').first().evaluate(el => getComputedStyle(el).borderRadius)).toBe('50%');
  expect(await album.locator('span').first().evaluate(el => getComputedStyle(el).borderRadius)).not.toBe('50%');
  await page.screenshot({ path: info.outputPath('search-home.png') });
  const scroll = page.locator('[data-primary-scroll]').first();
  await scroll.evaluate(el => { el.scrollTop = 160; });
  const offset = await scroll.evaluate(el => el.scrollTop);
  await albums.getByRole('link', { name: 'Ver todos: Álbumes para ti' }).click();
  await expect(page).toHaveURL(/browse=albums/);
  await expect(home.getByRole('link', { name: /^Un disco por descubrir / })).toHaveCount(10);
  await expect(home.getByRole('region', { name: 'Artistas por descubrir' })).toHaveCount(0);
  await home.getByRole('button', { name: 'Volver a Buscar' }).click();
  await expect(artists).toBeVisible();
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
