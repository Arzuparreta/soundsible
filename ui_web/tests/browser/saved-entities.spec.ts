import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine } from './music-browser-fixture';
import type { SavedEntity } from '../../src/lib/savedEntities';

test('save artist and album, reload, browse, remove and undo without changing songs', async ({ page }) => {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    const pulses: string[] = [];
    Object.assign(window, { navPulses: pulses });
    Element.prototype.animate = function (...args) {
      const href = this.closest('[data-nav-href]')?.getAttribute('data-nav-href');
      if (href) pulses.push(href);
      return animate.apply(this, args);
    };
  });
  await mockMusicEngine(page);
  let entities: SavedEntity[] = [];
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' || request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/library/saved-entities', async (route) => {
    if (route.request().method() === 'PUT') {
      const { entry, saved } = route.request().postDataJSON();
      entities = entities.filter((item) => item.destination !== entry.destination);
      if (saved) entities.unshift(entry);
    }
    await route.fulfill({ json: { entities } });
  });
  await page.route('**/api/catalog/artist?**', (route) => route.fulfill({ json: {
    name: 'Radiohead', resolved: true, deezer_id: '1', top_tracks: [],
    albums: [{ title: 'In Rainbows', deezer_id: '2' }], singles_eps: [], related_artists: [], candidates: [],
  } }));
  await page.route('**/api/catalog/album?**', (route) => route.fulfill({ json: {
    title: 'In Rainbows', artist: 'Radiohead', tracklist: [], resolved: true,
  } }));
  await page.goto('/player/#/artist/Radiohead?deezer_id=1');
  const artistPin = page.getByRole('button', { name: 'Añadir a marcadores', exact: true });
  await expect(artistPin).toHaveAttribute('title', 'Añadir a marcadores');
  await expect(artistPin).toHaveAttribute('aria-pressed', 'false');
  expect((await artistPin.textContent())?.trim()).toBe('');
  const artistMore = page.locator('[data-entity-toolbar]').getByRole('button', { name: 'Opciones', exact: true });
  const artistCover = page.getByTestId('collection-header-cover');
  const [pinBox, moreBox, coverBox] = await Promise.all([artistPin.boundingBox(), artistMore.boundingBox(), artistCover.boundingBox()]);
  expect(Math.abs((pinBox!.x + pinBox!.width / 2) - (moreBox!.x + moreBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(pinBox!.y).toBeGreaterThan(coverBox!.y);
  expect(pinBox!.y).toBeLessThan(moreBox!.y);
  await artistMore.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /marcadores/i })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await artistPin.click();
  await expect.poll(() => entities.length).toBe(1);
  const artistUnpin = page.getByRole('button', { name: 'Quitar de marcadores', exact: true });
  await expect(artistUnpin).toHaveAttribute('aria-pressed', 'true');
  await expect(artistUnpin).toHaveAttribute('title', 'Quitar de marcadores');
  await expect.poll(() => page.evaluate(() => (window as unknown as { navPulses: string[] }).navPulses)).toContain('/');
  await page.getByRole('link', { name: /In Rainbows/ }).click();
  await page.getByRole('button', { name: 'Añadir a marcadores', exact: true }).click();
  await expect.poll(() => entities.length).toBe(2);
  await page.goto('/player/#/');
  const artists = page.getByRole('region', { name: 'Artistas', exact: true });
  const saved = page.getByRole('region', { name: 'Álbumes', exact: true });
  await expect(artists.getByRole('link', { name: 'Radiohead', exact: true })).toBeVisible();
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toBeVisible();
  await expect(artists.locator('h2 svg')).toHaveCount(1);
  await expect(saved.locator('h2 svg')).toHaveCount(1);
  const [artistsBox, albumsBox] = await Promise.all([artists.boundingBox(), saved.boundingBox()]);
  expect(artistsBox!.y).toBeLessThan(albumsBox!.y);
  // The options button hangs below its card. Past the rail's padding it becomes
  // a vertical scroll range, and a scrollbar wherever scrollbars are classic.
  expect(await saved.locator('[data-horizontal-scroll]').evaluate((rail) => rail.scrollHeight - rail.clientHeight)).toBe(0);
  await page.reload();
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toBeVisible();
  await saved.getByRole('link', { name: 'Ver todos: Álbumes', exact: true }).click();
  await expect(page.locator('[data-primary-scroll]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('section[aria-label="Álbumes"]').analyze()).violations).toEqual([]);
  await saved.getByRole('button', { name: 'Opciones: In Rainbows', exact: true }).click();
  // A button in the phone's sheet, a menu item in the desktop popover.
  const remove = page.locator('button').filter({ hasText: /^Quitar de marcadores/ });
  await expect(remove.locator('mask')).toHaveCount(1);
  expect(await remove.evaluate((button) => {
    const probe = button.appendChild(document.createElement('span'));
    probe.style.color = 'var(--danger)';
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(button).color === danger;
  })).toBe(true);
  await remove.click();
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toBeVisible();
  await saved.getByRole('link', { name: 'In Rainbows', exact: true }).click();
  await expect(page).toHaveURL(/album\/In%20Rainbows.*deezer_id=2/);
  expect(writes.filter((path) => /saved\/toggle|favourites\/toggle|downloader\/add/.test(path))).toEqual([]);
});

test('small viewport keeps the collection usable and can leave it after removing the last item', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockMusicEngine(page);
  let entities: SavedEntity[] = [{ kind: 'artist', name: 'Radiohead', destination: '/artist/Radiohead?deezer_id=1' }];
  await page.route('**/api/library/saved-entities', async (route) => {
    if (route.request().method() === 'PUT') entities = [];
    await route.fulfill({ json: { entities } });
  });
  await page.goto('/player/#/');
  const saved = page.getByRole('region', { name: 'Artistas', exact: true });
  await saved.getByRole('link', { name: 'Ver todos: Artistas', exact: true }).click();
  const box = await saved.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  await saved.getByRole('button', { name: 'Opciones: Radiohead', exact: true }).click();
  await page.locator('button').filter({ hasText: /^Quitar de marcadores/ }).click();
  await expect(saved.getByRole('link')).toHaveCount(0);
  await page.getByRole('link', { name: /Volver a Biblioteca/ }).click();
  await expect(page.getByRole('region', { name: 'Tu biblioteca', exact: true })).toBeVisible();
  await expect(saved).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reintentar', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Canciones', exact: true }).click();
  await expect(page.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
});

test('Library opens its root and every subentry can be pinned to the bottom bar', async ({ page }, info) => {
  await mockMusicEngine(page);
  await page.goto('/player/#/');
  const shortcuts = page.getByRole('region', { name: 'Tu biblioteca', exact: true });
  await expect(shortcuts).toBeVisible();
  await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-library-scroll]')).toHaveCount(0);
  await shortcuts.getByRole('link', { name: 'Canciones', exact: true }).click();
  await expect(page).toHaveURL(/#\/library\?view=songs$/);
  await expect(page.getByText('Canción de biblioteca 320', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Biblioteca', exact: true }).filter({ visible: true }).click();
  await expect(shortcuts).toBeVisible();
  await expect(page.locator('[data-library-scroll]')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('library-root.png') });

  await page.goto('/player/#/settings/accessibility');
  await page.locator('summary').filter({ hasText: 'Barra inferior' }).click();
  const paths = ['/library?view=songs', '/library?view=albums', '/library?view=artists', '/?saved=bookmarks'];
  for (const path of paths) await expect(page.getByLabel('Posición 1').locator(`option[value="${path}"]`)).toHaveCount(1);
  await expect(page.getByLabel('Posición 1').locator('option[value="/?saved=albums"]')).toHaveCount(0);
  await expect(page.getByLabel('Posición 1').locator('option[value="/?saved=artists"]')).toHaveCount(0);
  await page.getByLabel('Posición 1').selectOption('/library?view=songs');
  await page.getByLabel('Posición 2').selectOption('/library?view=albums');
  await page.getByLabel('Posición 3').selectOption('/library?view=artists');
  await page.getByLabel('Posición 4').selectOption('/?saved=bookmarks');
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('navigation:bottom')!))).toEqual(paths);
  if (info.project.name.includes('mobile')) {
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    for (const [index, label] of ['Canciones', 'Álbumes', 'Artistas', 'Marcadores'].entries()) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${paths[index]}`);
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
    await page.screenshot({ path: info.outputPath('library-custom-bottom-bar.png') });
  }
});

test('every saved card is the same size, whatever the length of its name', async ({ page }) => {
  await mockMusicEngine(page);
  const entities: SavedEntity[] = ['Halo', 'Abel York', 'Extremoduro', 'Blue Oyster Cult'].flatMap((name, index) => [
    { kind: 'artist', name, destination: `/artist/${encodeURIComponent(name)}?deezer_id=${index + 1}` },
    { kind: 'album', name: `${name} Live`, artist: name, destination: `/album/${encodeURIComponent(name)}?deezer_id=${index + 10}` },
  ]);
  await page.route('**/api/library/saved-entities', (route) => route.fulfill({ json: { entities } }));
  const coverSizes = (region: string) => page.getByRole('region', { name: region, exact: true }).locator('article > a > div').evaluateAll(
    (covers) => covers.map((cover) => `${Math.round(cover.getBoundingClientRect().width)}x${Math.round(cover.getBoundingClientRect().height)}`));
  await page.goto('/player/#/');
  for (const region of ['Artistas', 'Álbumes']) {
    await expect.poll(() => coverSizes(region)).toHaveLength(4);
    expect(new Set(await coverSizes(region)).size, region).toBe(1);
  }
  await page.goto('/player/#/?saved=artists');
  await expect.poll(() => coverSizes('Artistas')).toHaveLength(4);
  expect(new Set(await coverSizes('Artistas')).size).toBe(1);
});

test('a compatibility-normalized saved match suppresses the Library empty state', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/library/saved-entities', route => route.fulfill({ json: { entities: [
    { kind: 'album', name: 'Oﬃce', artist: 'Björk', destination: '/album/Office?artist=Bjork&deezer_id=1' },
  ] } }));
  await page.goto('/player/#/library?view=songs&q=office');
  await expect(page.getByRole('link', { name: 'Oﬃce', exact: true })).toBeVisible();
  await expect(page.getByText('No hay canciones ni artistas que coincidan.')).toHaveCount(0);

  await page.goto('/player/#/?saved=albums');
  const field = page.getByRole('searchbox', { name: 'Filtrar esta lista' });
  await field.fill('BJORK');
  await expect(page.getByRole('link', { name: 'Oﬃce', exact: true })).toBeVisible();
  await field.fill('missing');
  await expect(page.getByText('No hay coincidencias en esta lista.')).toBeVisible();
});
