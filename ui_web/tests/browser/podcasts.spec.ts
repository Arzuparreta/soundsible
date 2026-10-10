import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockMusicEngine, TRACKS, silentWav } from './music-browser-fixture';
import { dragTouch } from './playerGestures';

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
  await page.route('**/api/discovery/podcasts/top?**', (route) => route.fulfill({ json: { country: 'us', results: [POPULAR] } }));
  await page.route('**/api/discovery/podcasts/top-episodes?**', (route) => route.fulfill({ json: { country: 'us', results: [] } }));
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
  await target.scrollIntoViewIfNeeded();
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


/** The followed show's episodes as the engine answers each way of asking:
 * `cached` with what it kept, a look at the feed with `onCheck`'s answer, and
 * a refresh with an episode published since. Every mode asked is recorded. */
async function mockFeedModes(page: Page, onCheck: () => Promise<{ episodes: ReturnType<typeof episode>[]; changed: boolean }>) {
  const asked: string[] = [];
  const kept = [episode('Episodio guardado')];
  await page.route((url) => url.pathname === '/api/podcasts/feeds/show-1/episodes', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const mode = query.has('cached') ? 'cached' : query.has('refresh') ? 'refresh' : 'check';
    asked.push(mode);
    const answer = mode === 'cached' ? { episodes: kept, changed: false }
      : mode === 'refresh' ? { episodes: [episode('Episodio recién subido'), ...kept], changed: true }
        : await onCheck();
    return route.fulfill({ json: { feed_id: 'show-1', subscription: FOLLOWED, ...answer } });
  });
  return { asked, kept };
}

test('a followed show opens on what was kept, and the episode published since joins it', async ({ page }) => {
  await mockPodcasts(page);
  let publish!: () => void;
  const published = new Promise<void>((resolve) => { publish = resolve; });
  const { asked, kept } = await mockFeedModes(page, async () => {
    await published;
    return { episodes: [episode('Episodio nuevo'), ...kept], changed: true };
  });
  await page.goto('/player/#/podcasts/show-1');
  // The page does not wait on the feed to show the show.
  await expect(page.getByText('Episodio guardado', { exact: true })).toBeVisible();
  await expect(page.getByText('Episodio nuevo', { exact: true })).toHaveCount(0);
  publish();
  await expect(page.getByText('Episodio nuevo', { exact: true })).toBeVisible();
  expect(asked).toEqual(['cached', 'check']);
});

test('the refresh button reads the feed again', async ({ page, isMobile }) => {
  await mockPodcasts(page);
  const { asked, kept } = await mockFeedModes(page, async () => ({ episodes: kept, changed: false }));
  await page.goto('/player/#/podcasts/show-1');
  await expect(page.getByText('Episodio guardado', { exact: true })).toBeVisible();
  await expect.poll(() => asked).toEqual(['cached', 'check']);
  const button = page.getByRole('button', { name: 'Actualizar episodios', exact: true });
  if (isMobile) await button.tap(); else await button.click();
  await expect(page.getByText('Episodio recién subido', { exact: true })).toBeVisible();
  expect(asked).toEqual(['cached', 'check', 'refresh']);
});

test('pulling the episode list down from its top refreshes it', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'CDP provides real multi-event touch input');
  await mockPodcasts(page);
  const { asked, kept } = await mockFeedModes(page, async () => ({ episodes: kept, changed: false }));
  await page.goto('/player/#/podcasts/show-1');
  await expect(page.getByText('Episodio guardado', { exact: true })).toBeVisible();
  await expect.poll(() => asked).toEqual(['cached', 'check']);
  // A short pull lets go without asking for anything.
  await dragTouch(page, '[data-primary-scroll]', { dy: 60 });
  await page.waitForTimeout(100);
  expect(asked).toEqual(['cached', 'check']);
  await dragTouch(page, '[data-primary-scroll]', { dy: 260 });
  await expect(page.getByText('Episodio recién subido', { exact: true })).toBeVisible();
  expect(asked).toEqual(['cached', 'check', 'refresh']);
});

test('podcast buttons jump 15 seconds and each show resumes after switching and reloading', async ({ page, isMobile }) => {
  await mockPodcasts(page);
  await page.route('**/api/podcasts/enclosure/peek', route => route.fulfill({ json: { stream_token: 'episode' } }));
  await page.route('**/api/podcasts/stream/**', route => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), silentWav.length - 1) : silentWav.length - 1;
    return route.fulfill({
      status: range ? 206 : 200, contentType: 'audio/wav', body: silentWav.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${silentWav.length}` } : {}) },
    });
  });
  await page.goto('/player/#/podcasts/show-1');
  await page.getByRole('button', { name: /^Reproducir episodio:/ }).click();
  const pill = page.locator('[data-omni-player]');
  await expect(pill.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
  await pill.getByRole('button', { name: /^NORMAL:/ }).click();
  const stage = page.locator('[data-player-stage-mode="now-playing"]');
  const position = () => page.evaluate(async () => {
    // Read the real media clock, so these assertions include the browser seek.
    const { audioService } = await import('/player/src/lib/audio.ts');
    return audioService.snapshot().position;
  });
  await expect.poll(() => page.evaluate(async () => {
    const { audioService } = await import('/player/src/lib/audio.ts');
    return audioService.snapshot().duration;
  })).toBe(180);
  const forward = stage.getByRole('button', { name: 'Avanzar 15 segundos' });
  const playingPosition = await position();
  if (isMobile) await forward.tap(); else await forward.click();
  await expect.poll(position).toBeGreaterThanOrEqual(playingPosition + 14);
  await expect.poll(() => page.evaluate(async () => {
    const { audioService } = await import('/player/src/lib/audio.ts');
    return audioService.snapshot().playing;
  })).toBe(true);
  const jumpedPosition = await position();
  await expect.poll(position).toBeGreaterThan(jumpedPosition + 0.1);
  await stage.getByRole('button', { name: 'Pausar', exact: true }).click();
  const startPosition = await position();
  await forward.click();
  await forward.click();
  await expect.poll(position).toBeCloseTo(startPosition + 30, 0);
  await stage.getByRole('button', { name: 'Retroceder 15 segundos' }).click();
  await expect.poll(position).toBeCloseTo(startPosition + 15, 0);
  await forward.click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '/podcasts/feed?url=https%3A%2F%2Ffeeds.example.com%2Fpopular.xml'; });
  await page.getByRole('button', { name: /^Reproducir episodio:/ }).click();
  await expect.poll(position).toBeLessThan(5);
  await page.evaluate(() => { location.hash = '/podcasts/show-1'; });
  await page.getByRole('button', { name: /^Reproducir episodio:/ }).click();
  await expect.poll(position).toBeGreaterThanOrEqual(29);
  await page.reload();
  await page.getByRole('button', { name: /^Reproducir episodio:/ }).click();
  await expect.poll(position).toBeGreaterThanOrEqual(29);
  await expect(pill.getByRole('button', { name: 'Avanzar 15 segundos' })).toBeVisible();
});

test('the globe selects the account country from the mobile header or desktop search bar', async ({ page, isMobile }, testInfo) => {
  await mockPodcasts(page);
  let country = 'us';
  await page.route('**/api/discovery/settings', async route => {
    if (route.request().method() === 'PATCH') country = route.request().postDataJSON().podcast_country;
    await route.fulfill({ json: { podcast_country: country, learning_enabled: true, autoplay_enabled: false } });
  });
  await page.route('**/api/discovery/podcasts/top?**', route => {
    const selected = new URL(route.request().url()).searchParams.get('country');
    return route.fulfill({ json: { country: selected, results: [{ ...POPULAR, title: `Podcast de ${selected}` }] } });
  });
  await page.route('**/api/discovery/podcasts/top-episodes?**', route => {
    const selected = new URL(route.request().url()).searchParams.get('country');
    return route.fulfill({ json: { country: selected, results: [{ ...POPULAR, episode_id: '900', itunes_collection_id: '123', title: `Episodio de ${selected}` }] } });
  });
  await page.goto('/player/#/podcasts');
  const selector = page.getByRole('combobox', { name: 'País para descubrir podcasts' });
  await expect(selector).toHaveValue('us');
  if (isMobile) {
    await expect(page.locator('[data-app-bar]').getByRole('combobox')).toBeVisible();
  } else {
    const search = await page.getByPlaceholder('Buscar podcasts…').boundingBox();
    const globe = await selector.boundingBox();
    expect(globe!.x).toBeGreaterThan(search!.x + search!.width);
  }
  await selector.selectOption('es');
  await expect(selector).toHaveValue('es');
  await expect(page.getByRole('heading', { name: 'Podcasts populares en España' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Episodios populares en España' })).toBeVisible();
  await expect(page.getByText('Episodio de es', { exact: true })).toBeVisible();
  await expect(page.getByText('Podcast de us', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('podcast-country.png') });
  await page.goto('/player/#/settings/playback');
  await expect(page.getByRole('combobox', { name: 'País para descubrir podcasts' })).toHaveValue('es');
});

test('a popular episode resolves and plays its exact audio without subscribing', async ({ page, isMobile }) => {
  const { followed } = await mockPodcasts(page);
  await page.route('**/api/discovery/podcasts/top-episodes?**', route => route.fulfill({ json: {
    results: [{ ...POPULAR, episode_id: '900', itunes_collection_id: '123', title: 'Capítulo popular exacto' }],
  } }));
  const resolved: string[] = [];
  await page.route('**/api/discovery/podcasts/episode?**', route => {
    const url = new URL(route.request().url());
    resolved.push(url.searchParams.get('episode_id')!);
    return route.fulfill({ json: { show_title: 'Programa popular', feed_url: POPULAR.feed_url,
      episode: { ...episode('Capítulo popular exacto'), guid: 'guid-900' } } });
  });
  await page.route('**/api/podcasts/enclosure/peek', route => route.fulfill({ json: { stream_token: 'episode-token' } }));
  await page.route('**/api/podcasts/stream/**', route => route.fulfill({ contentType: 'audio/wav', body: silentWav }));
  await page.goto('/player/#/podcasts');
  const row = page.getByText('Capítulo popular exacto', { exact: true });
  await expect(row).toBeVisible();
  expect(resolved).toEqual([]);
  await tapArtwork(page, row, isMobile);
  await expect.poll(() => resolved).toEqual(['900']);
  await expect(page.locator('[data-omni-player]')).toContainText('Capítulo popular exacto');
  await expect(page.locator('[data-omni-player]').getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
  expect(followed).toEqual([]);
});

for (const oldFeedId of [undefined, 'previous-subscription']) {
  test(`a popular episode reuses its RSS download with feed id ${oldFeedId ?? 'absent'}`, async ({ page, isMobile }) => {
    await mockPodcasts(page);
    const downloaded = { id: 'downloaded-900', title: 'Capítulo descargado', artist: 'Programa popular', duration: 600,
      media_kind: 'podcast_episode', podcast_episode_guid: 'guid-900', podcast_rss_url: POPULAR.feed_url,
      podcast_feed_id: oldFeedId };
    await page.route((url) => url.pathname === '/api/library', route => route.fulfill({ json: {
      tracks: [{ ...downloaded, id: 'unrelated-download', podcast_rss_url: FOUND.feed_url }, downloaded],
      playlists: {}, settings: {}, podcast_subscriptions: [{ ...FOLLOWED, rss_url: POPULAR.feed_url }],
    } }));
    await page.route('**/api/discovery/podcasts/top-episodes?**', route => route.fulfill({ json: {
      results: [{ ...POPULAR, episode_id: '900', itunes_collection_id: '123', title: 'Capítulo popular exacto' }],
    } }));
    await page.route('**/api/discovery/podcasts/episode?**', route => route.fulfill({ json: {
      show_title: 'Programa popular', feed_url: POPULAR.feed_url,
      episode: { ...episode('Capítulo popular exacto'), guid: 'guid-900' },
    } }));
    const streams: string[] = [], previews: string[] = [];
    await page.route('**/api/static/stream/**', route => {
      streams.push(new URL(route.request().url()).pathname);
      return route.fulfill({ contentType: 'audio/wav', body: silentWav });
    });
    await page.route('**/api/podcasts/enclosure/peek', route => {
      previews.push(route.request().url());
      return route.abort();
    });
    await page.goto('/player/#/podcasts');
    const row = page.getByText('Capítulo popular exacto', { exact: true });
    await expect(row).toBeVisible();
    await tapArtwork(page, row, isMobile);
    await expect(page.locator('[data-omni-player]')).toContainText(downloaded.title);
    await expect(page.locator('[data-omni-player]').getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
    expect(streams).toContain('/api/static/stream/downloaded-900');
    expect(streams).not.toContain('/api/static/stream/unrelated-download');
    expect(previews).toEqual([]);
  });
}

test('category filters both country rankings while keeping followed shows visible', async ({ page }) => {
  await mockPodcasts(page);
  const news = [{ id: '1489', name: 'Noticias' }], comedy = [{ id: '1303', name: 'Comedia' }];
  await page.route('**/api/discovery/podcasts/top?**', route => route.fulfill({ json: { results: [
    { ...POPULAR, title: 'Podcast noticias', genres: news }, { ...FOUND, title: 'Podcast comedia', genres: comedy },
  ] } }));
  await page.route('**/api/discovery/podcasts/top-episodes?**', route => route.fulfill({ json: { results: [
    { ...POPULAR, title: 'Episodio noticias', episode_id: '900', genres: news },
    { ...FOUND, title: 'Episodio comedia', episode_id: '901', genres: comedy },
  ] } }));
  await page.goto('/player/#/podcasts');
  const category = page.getByRole('combobox', { name: 'Filtrar estas listas por categoría' });
  await category.selectOption('1303');
  await expect(page.getByText('Podcast comedia', { exact: true })).toBeVisible();
  await expect(page.getByText('Episodio comedia', { exact: true })).toBeVisible();
  await expect(page.getByText('Podcast noticias', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Episodio noticias', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Programa seguido', { exact: true })).toBeVisible();
  await category.selectOption('');
  await expect(page.getByText('Podcast noticias', { exact: true })).toBeVisible();
});
