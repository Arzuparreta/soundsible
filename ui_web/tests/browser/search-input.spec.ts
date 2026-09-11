import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('intelligent search keeps artist filters available while pending and after completion', async ({ page }) => {
  await mockMusicEngine(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const queries: string[] = [];
  const peeks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/youtube/peek')) peeks.push(request.url());
  });
  await page.route('**/api/catalog/search?**', async (route) => {
    queries.push(new URL(route.request().url()).searchParams.get('q') || '');
    await pending;
    await route.fulfill({ json: {
      items: [{ id: 'artist:extremoduro', type: 'artist', source: 'deezer', title: 'Extremoduro', artist: 'Extremoduro' }],
      sections: [{ id: 'top', item_ids: ['artist:extremoduro'] }, { id: 'artists', item_ids: ['artist:extremoduro'] }],
    } });
  });
  await page.goto('/player/#/search');
  const input = page.getByRole('searchbox', { name: 'Qué quieres escuchar?' });
  await input.fill('Extremoduro');
  const artists = page.getByRole('tab', { name: 'Artistas', exact: true });
  await expect(artists).toBeVisible();
  await artists.click();
  await expect.poll(() => queries.length).toBe(1);
  await expect(artists).toHaveAttribute('aria-selected', 'true');
  release();
  await expect(page.getByText('Extremoduro', { exact: true }).first()).toBeVisible();
  await expect(artists).toBeVisible();
  await expect(artists).toHaveAttribute('aria-selected', 'true');
  expect(queries).toEqual(['Extremoduro']);
  expect(peeks).toEqual([]);
  const tabs = page.getByRole('tablist');
  const box = await tabs.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
