import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockMusicEngine } from './music-browser-fixture';
import type { SavedEntity } from '../../src/lib/savedEntities';

test('save artist and album, reload, browse, remove and undo without changing songs', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardado', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: /In Rainbows/ }).click();
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect.poll(() => entities.length).toBe(2);
  await expect(page.getByText('Guardado en Biblioteca', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Ver', exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  const saved = page.getByRole('region', { name: 'Álbumes guardados', exact: true });
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Artistas guardados' }).getByRole('link', { name: 'Radiohead', exact: true })).toBeVisible();
  await page.reload();
  await expect(saved.getByRole('link', { name: 'In Rainbows', exact: true })).toBeVisible();
  await saved.getByRole('link', { name: 'Ver todos: Álbumes guardados', exact: true }).click();
  await expect(page.locator('[data-primary-scroll]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('section[aria-label="Álbumes guardados"]').analyze()).violations).toEqual([]);
  await saved.getByRole('button', { name: 'Opciones: In Rainbows', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar de guardados', exact: true }).click();
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
  const saved = page.getByRole('region', { name: 'Artistas guardados', exact: true });
  await saved.getByRole('link', { name: 'Ver todos: Artistas guardados', exact: true }).click();
  const box = await saved.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  await saved.getByRole('button', { name: 'Opciones: Radiohead', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar de guardados', exact: true }).click();
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
  const paths = ['/library?view=songs', '/library?view=albums', '/library?view=artists', '/?saved=albums', '/?saved=artists'];
  for (const path of paths) await expect(page.getByLabel('Posición 1').locator(`option[value="${path}"]`)).toHaveCount(1);
  await page.getByLabel('Posición 1').selectOption('/library?view=songs');
  await page.getByLabel('Posición 2').selectOption('/library?view=albums');
  await page.getByLabel('Posición 3').selectOption('/library?view=artists');
  await page.getByLabel('Posición 4').selectOption('/?saved=albums');
  await page.getByRole('button', { name: 'Añadir destino', exact: true }).click();
  await page.getByLabel('Posición 5').selectOption('/?saved=artists');
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('navigation:bottom')!))).toEqual(paths);
  if (info.project.name.includes('mobile')) {
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    for (const [index, label] of ['Canciones', 'Álbumes', 'Artistas', 'Álbumes guardados', 'Artistas guardados'].entries()) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${paths[index]}`);
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
    await page.screenshot({ path: info.outputPath('library-custom-bottom-bar.png') });
  }
});
