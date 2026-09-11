import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, TRACKS } from './music-browser-fixture';

test('NORMAL and DJ choose artwork for the rendered slot and device density', async ({ page }) => {
  await mockMusicEngine(page);
  await page.route('**/api/library?*', route => route.fulfill({ json: {
    tracks: TRACKS.map(track => ({ ...track, artwork_revision: 'fixture-1', artwork_width: 1280, artwork_height: 720 })),
    playlists: {}, settings: {}, podcast_subscriptions: [],
  } }));
  const images: string[] = [];
  await page.route('**/api/static/cover/**', route => {
    const url = new URL(route.request().url());
    images.push(url.toString());
    const size = Math.min(Number(url.searchParams.get('size')) || 1280, 720);
    return route.fulfill({ contentType: 'image/svg+xml', body:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 720 720"><defs><linearGradient id="g"><stop stop-color="#235789"/><stop offset="1" stop-color="#ef709d"/></linearGradient></defs><rect width="720" height="720" fill="url(#g)"/><circle cx="360" cy="360" r="200" fill="#102030"/><circle cx="360" cy="360" r="60" fill="#ef709d"/></svg>` });
  });
  await openMusicPlayer(page);
  const verify = async (mode: string) => {
    const image = page.locator(`[data-player-stage-mode="${mode}"] [data-player-cover-slot] img`);
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const info = await image.evaluate((element: HTMLImageElement) => ({
      src: element.currentSrc, width: element.getBoundingClientRect().width, density: devicePixelRatio,
    }));
    const url = new URL(info.src);
    const selected = Math.min(Number(url.searchParams.get('size')), 720);
    expect(selected).toBeGreaterThanOrEqual(Math.min(Math.ceil(info.width * info.density), 720));
    expect(url.searchParams.get('fit')).toBe('square');
    expect(url.searchParams.get('rev')).toBe('fixture-1');
    expect(await image.getAttribute('loading')).toBe('eager');
  };
  await verify('now-playing');
  await page.getByRole('tab', { name: /DJ/ }).click();
  await verify('auto');
  // The image element's fallback original must not cause an extra original download.
  expect(images.filter(src => !new URL(src).searchParams.has('size'))).toEqual([]);
  await page.screenshot({ path: `/tmp/soundsible-artwork-${test.info().project.name}.png` });
});
