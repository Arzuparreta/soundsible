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
