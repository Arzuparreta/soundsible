import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockMusicEngine, TRACKS } from './music-browser-fixture';

const FOLLOWED = { id: 'show-1', title: 'Programa seguido', author: 'Autora', rss_url: 'https://feeds.example.com/seguido.xml', image_url: null };
const POPULAR = { title: 'Programa popular', author: 'Alguien', feed_url: 'https://feeds.example.com/popular.xml', recommendation_identity: 'podcast:popular' };
const FOUND = { title: 'Programa buscado', author: 'Otra persona', feed_url: 'https://feeds.example.com/buscado.xml' };
const episode = (title: string) => ({ guid: title, title, enclosure_url: `https://cdn.example.com/${encodeURIComponent(title)}.mp3`, duration_sec: 600 });

/** An engine with one followed show, one popular show and one search result.
 * Following a show adds it to the library the way the engine does; the list of
 * what was followed is how a test tells opening a show from following it. */
async function mockPodcasts(page: Page) {
  const subscriptions = [FOLLOWED];
  const followed: string[] = [];
  await mockMusicEngine(page);
  await page.route((url) => url.pathname === '/api/library', (route) => route.fulfill({ json: {
    tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: subscriptions,
  } }));
  await page.route('**/api/discovery/podcasts/recommendations**', (route) => route.fulfill({ json: { items: [POPULAR] } }));
  await page.route('**/api/discovery/podcasts/search**', (route) => route.fulfill({ json: { results: [FOUND] } }));
  await page.route('**/api/podcasts/feeds/**', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4]);
    const subscription = subscriptions.find((sub) => sub.id === id);
    return route.fulfill({ json: { feed_id: id, subscription, episodes: [episode(`Episodio de ${subscription?.title}`)] } });
  });
  await page.route('**/api/podcasts/episodes-by-url?**', (route) => {
    const rss = new URL(route.request().url()).searchParams.get('rss_url');
    const show = [POPULAR, FOUND].find((row) => row.feed_url === rss)!;
    return route.fulfill({ json: { rss_url: rss, show: { title: show.title, author: show.author, image_url: '' },
      episodes: [episode(`Episodio de ${show.title}`)] } });
  });
  await page.route('**/api/podcasts/subscribe', (route) => {
    const body = route.request().postDataJSON() as { rss_url: string; title: string; author?: string };
    followed.push(body.rss_url);
    const subscription = { id: `show-${subscriptions.length + 1}`, title: body.title, author: body.author ?? '', rss_url: body.rss_url, image_url: null };
    subscriptions.push(subscription);
    return route.fulfill({ json: { status: 'success', subscription } });
  });
  return { followed };
}

/** Press the artwork, where nearly every tap on a card lands. */
async function tapArtwork(page: Page, target: Locator, isMobile: boolean) {
  const box = (await target.boundingBox())!;
  const point = { x: box.x + Math.min(box.width, box.height) / 2, y: box.y + Math.min(box.width, box.height) / 2 };
  if (isMobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
}

test('a followed show opens from its artwork', async ({ page, isMobile }) => {
  await mockPodcasts(page);
  await page.goto('/player/#/podcasts');
  const card = page.getByRole('link', { name: /Programa seguido/ });
  await expect(card).toBeVisible();
  await tapArtwork(page, card, isMobile);
  await expect(page).toHaveURL(/#\/podcasts\/show-1$/);
  await expect(page.getByText('Episodio de Programa seguido', { exact: true })).toBeVisible();
});

test('a popular show opens before it is followed, and following it there moves to its own page', async ({ page, isMobile }) => {
  const { followed } = await mockPodcasts(page);
  await page.goto('/player/#/podcasts');
  const card = page.getByRole('link', { name: /Programa popular/ });
  await expect(card).toBeVisible();
  // A tap used to follow the show instead of opening it: nothing opened, and a
  // show got followed just for being looked at.
  await tapArtwork(page, card, isMobile);
  await expect(page).toHaveURL(/#\/podcasts\/feed\?url=https%3A%2F%2Ffeeds\.example\.com%2Fpopular\.xml$/);
  await expect(page.getByRole('heading', { name: 'Programa popular', exact: true })).toBeVisible();
  await expect(page.getByText('Episodio de Programa popular', { exact: true })).toBeVisible();
  expect(followed).toEqual([]);

  await page.getByRole('button', { name: 'Suscribir', exact: true }).click();
  await expect(page).toHaveURL(/#\/podcasts\/show-2$/);
  await expect(page.getByRole('button', { name: 'Dejar de seguir', exact: true })).toBeVisible();
  expect(followed).toEqual([POPULAR.feed_url]);
  await page.goBack();
  await expect(page).toHaveURL(/#\/podcasts$/);
});

test('a search result opens its show, and its own button still follows without opening', async ({ page, isMobile }) => {
  const { followed } = await mockPodcasts(page);
  await page.goto('/player/#/podcasts?q=buscado');
  const result = page.getByText('Programa buscado', { exact: true });
  await expect(result).toBeVisible();
  if (!isMobile) {
    await page.getByRole('button', { name: 'Suscribir', exact: true }).click();
    await expect(page.getByText('Suscrito', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/podcasts\?q=buscado$/);
    expect(followed).toEqual([FOUND.feed_url]);
  }
  if (isMobile) await result.tap(); else await result.click();
  await expect(page.getByText('Episodio de Programa buscado', { exact: true })).toBeVisible();
  // Followed a moment ago on desktop, so it opens as the followed show.
  await expect(page).toHaveURL(isMobile ? /#\/podcasts\/feed\?url=/ : /#\/podcasts\/show-2$/);
});
