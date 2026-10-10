import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test.use({ reducedMotion: 'no-preference' });

/** Observe before navigation so an assertion cannot miss the first frames. */
async function observeReturn(page: Page) {
  return page.evaluate(async () => {
    const frames: { opacity: string; transform: string; theme: string | undefined; top: number }[] = [];
    history.back();
    for (let i = 0; i < 24; i++) {
      // Sample after all callbacks for this paint, including scroll restoration.
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!location.hash.startsWith('#/search')) continue;
      const view = document.querySelector('[data-app-outlet] .view');
      if (!view?.querySelector('input[type="search"]')) continue;
      const style = getComputedStyle(view);
      frames.push({ opacity: style.opacity, transform: style.transform, theme: document.documentElement.dataset.theme, top: view.querySelector('[data-primary-scroll]')?.scrollTop ?? 0 });
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

test('theme paints atomically and a return keeps the selected palette', async ({ page }) => {
  await page.goto('/player/#/search');
  await expect(page.getByRole('searchbox')).toBeVisible();
  await page.evaluate(() => { location.hash = '/settings/appearance'; });
  await page.getByRole('radio', { name: 'Claro', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // A control with its own colour transition must switch with the palette too.
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'palette-probe';
    probe.style.cssText = 'background-color:var(--bg-base);transition:background-color 2s linear;width:1px;height:1px';
    document.body.append(probe);
    void probe.offsetWidth;
  });
  await page.getByRole('radio', { name: 'Oscuro', exact: true }).check();
  const colors = await page.evaluate(() => {
    const probe = document.getElementById('palette-probe')!;
    const actual = getComputedStyle(probe).backgroundColor;
    const reference = document.createElement('div');
    reference.style.backgroundColor = 'var(--bg-base)';
    document.body.append(reference);
    const expected = getComputedStyle(reference).backgroundColor;
    probe.remove();
    reference.remove();
    return { actual, expected, painting: document.documentElement.hasAttribute('data-theme-paint') };
  });
  expect(colors.actual).toBe(colors.expected);
  expect(colors.painting).toBe(false);
  const frames = await observeReturn(page);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every(frame => frame.theme === 'dark' && frame.opacity === '1' && frame.transform === 'none')).toBe(true);
  await expect(page.getByRole('searchbox')).toBeVisible();
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

for (const back of ['app', 'history'] as const) {
  test(`Settings index keeps its painted palette when returning via ${back}`, async ({ page }) => {
    if (back === 'app') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/player/#/settings');
    const search = page.getByRole('searchbox');
    await expect(search).toBeVisible();
    await page.evaluate(() => Object.assign(window, { settingsIndex: document.querySelector('[data-settings-page] input[type="search"]') }));
    for (const [from, to, theme] of [['Claro', 'Oscuro', 'dark'], ['Oscuro', 'Claro', 'light']]) {
      await page.getByRole('button', { name: /^Apariencia/ }).click();
      await page.getByRole('radio', { name: from, exact: true }).check();
      await page.getByRole('radio', { name: to, exact: true }).check();
      const framesPromise = page.evaluate(async () => {
        const frames: { color: string; expected: string; connected: boolean }[] = [];
        const index = (window as unknown as { settingsIndex: HTMLInputElement }).settingsIndex;
        for (let i = 0; i < 30; i++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          if (location.hash !== '#/settings') continue;
          frames.push({ color: getComputedStyle(index).color, expected: getComputedStyle(document.body).color, connected: index.isConnected });
        }
        return frames;
      });
      if (back === 'app') await page.getByRole('button', { name: 'Volver', exact: true }).click();
      else await page.goBack();
      const frames = await framesPromise;
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every(frame => frame.connected && frame.color === frame.expected)).toBe(true);
      await expect(search).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => (window as unknown as { settingsIndex: Element }).settingsIndex === document.querySelector('[data-settings-page] input[type="search"]'))).toBe(true);
    }
  });
}
