import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test.use({ reducedMotion: 'no-preference' });

/** Observe before navigation so an assertion cannot miss the first frames. */
async function observeReturn(page: Page) {
  return page.evaluate(async () => {
    const frames: { opacity: string; transform: string; top: number }[] = [];
    history.back();
    for (let i = 0; i < 24; i++) {
      // Sample after all callbacks for this paint, including scroll restoration.
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!location.hash.startsWith('#/search')) continue;
      const view = document.querySelector('[data-app-outlet] .view');
      if (!view?.querySelector('input[type="search"]')) continue;
      const style = getComputedStyle(view);
      frames.push({ opacity: style.opacity, transform: style.transform, top: view.querySelector('[data-primary-scroll]')?.scrollTop ?? 0 });
    }
    return frames;
  });
}

test.beforeEach(async ({ page }) => {
  await mockMusicEngine(page);
});

test('cached search returns fully painted without re-querying or fading', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/catalog/search?**', route => {
    requests++;
    return route.fulfill({ json: { items: Array.from({ length: 40 }, (_, index) => ({ id: `artist:${index}`, type: 'artist', source: 'deezer', title: `Resultado estable ${index}`, external_ids: { deezer_artist_id: String(index) } })), sections: [] } });
  });
  await page.goto('/player/#/search?q=stable');
  await expect(page.getByText('Resultado estable').first()).toBeVisible();
  const savedTop = await page.locator('[data-primary-scroll]').evaluate(async element => {
    element.scrollTop = 400;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return element.scrollTop;
  });
  expect(savedTop).toBeGreaterThan(0);
  await page.evaluate(() => { location.hash = '/library'; });
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  const frames = await observeReturn(page);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every(frame => frame.opacity === '1' && frame.transform === 'none')).toBe(true);
  await expect(page.getByText('Resultado estable').first()).toBeVisible();
  expect(requests).toBe(1);
  expect(frames.every(frame => frame.top === savedTop)).toBe(true);
});

test('Library artwork remains mounted through bookmark revalidation on return', async ({ page }) => {
  const artwork = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
  let reads = 0;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/library/saved-entities', async route => {
    if (++reads > 1) await response;
    await route.fulfill({ json: { entities: [
      { kind: 'album', name: 'Record', destination: '/album/Record?deezer_id=1', cover: artwork },
      { kind: 'artist', name: 'Band', destination: '/artist/Band?deezer_id=2', cover: artwork },
    ] } });
  });
  await page.goto('/player/#/');
  const images = page.locator('[data-primary-scroll] article img');
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).complete))).toBe(true);
  await page.evaluate(() => { location.hash = '/search'; });
  await expect(page.getByRole('searchbox')).toBeVisible();
  await page.goBack();
  await expect(images).toHaveCount(2);
  await expect(images.first()).toHaveAttribute('loading', 'eager');
  await expect(images.first()).toHaveAttribute('decoding', 'sync');
  await page.evaluate(() => {
    const retained = [...document.querySelectorAll('[data-primary-scroll] article img')];
    Object.assign(window, { retainedArtwork: retained });
  });
  const refreshed = page.waitForResponse('**/api/library/saved-entities');
  release();
  await refreshed;
  await expect(page.locator('[data-primary-scroll] > [aria-busy]')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => {
    const retained = (window as unknown as { retainedArtwork: Element[] }).retainedArtwork;
    return retained.every((node, index) => node.isConnected && document.querySelectorAll('[data-primary-scroll] article img')[index] === node);
  })).toBe(true);
});
