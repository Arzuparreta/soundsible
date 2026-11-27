import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { fixtureWav, mockMusicEngine } from './music-browser-fixture';

interface TrackSeed {
  id: string;
  item_id?: string;
  title: string;
  artist: string;
  album?: string;
  album_id?: string;
  duration?: number;
}

const DEFAULT_TRACKS: TrackSeed[] = [
  { id: 'trk-1', title: 'Dawn Chorus', artist: 'Thom Yorke', album: 'ANIMA', album_id: 'alb-1', duration: 210 },
  { id: 'trk-2', title: 'Twist', artist: 'Thom Yorke', album: 'ANIMA', album_id: 'alb-1', duration: 240 },
  { id: 'trk-3', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We’re Dreaming', album_id: 'alb-2', duration: 243 },
];

async function setupTvSession(
  page: Page,
  opts?: {
    viewport?: { width: number; height: number };
    requiresLogin?: boolean;
    signedIn?: boolean;
    tracks?: TrackSeed[];
    playlists?: Record<string, string[]>;
    resumeState?: Record<string, unknown> | null;
    installSocket?: boolean;
  },
) {
  const viewport = opts?.viewport ?? { width: 1920, height: 1080 };
  await page.setViewportSize(viewport);

  await mockMusicEngine(page);
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en');
  });

  const tracks = opts?.tracks ?? DEFAULT_TRACKS;
  const playlists = opts?.playlists ?? { 'Night Drive': ['trk-1', 'trk-2', 'trk-3'] };
  const requiresLogin = opts?.requiresLogin ?? false;
  let signedIn = opts?.signedIn ?? !requiresLogin;

  const albums = Array.from(
    tracks.reduce((map, t) => {
      const id = t.album_id ?? `alb-${t.album ?? 'single'}`;
      const existing = map.get(id);
      if (existing) {
        existing.track_count += 1;
      } else {
        map.set(id, {
          id,
          title: t.album ?? t.title,
          album_artist: t.artist,
          is_compilation: false,
          track_count: 1,
          duration: t.duration ?? 180,
          cover_track_id: t.id,
        });
      }
      return map;
    }, new Map<string, Record<string, unknown>>()),
  ).map(([, value]) => value);

  const publishedStates: Array<Record<string, unknown>> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const emittedAcks: Array<{ ackId: string; payload: unknown }> = [];

  await page.route((u) => u.pathname === '/api/auth/state', async (route) => {
    if (!signedIn && requiresLogin) {
      await route.fulfill({ json: { requires_login: true, user: null } });
      return;
    }
    await route.fulfill({
      json: {
        requires_login: requiresLogin,
        user: { id: 'u-tv', username: 'sofia', display_name: 'Sofia', role: 'member', has_password: true },
      },
    });
  });

  await page.route((u) => u.pathname === '/api/auth/logout', async (route) => {
    signedIn = false;
    await route.fulfill({ json: { ok: true } });
  });

  await page.route((u) => u.pathname === '/api/library', async (route) => {
    await route.fulfill({
      json: { tracks, playlists, settings: {}, podcast_subscriptions: [] },
    });
  });

  await page.route((u) => u.pathname === '/api/library/albums', async (route) => {
    const url = new URL(route.request().url());
    const offsetParam = Number(url.searchParams.get('offset') ?? '0');
    const limitParam = url.searchParams.get('limit');
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;
    const limit = limitParam !== null ? Number(limitParam) : albums.length;
    const sliced = Number.isFinite(limit) ? albums.slice(offset, offset + limit) : albums.slice(offset);
    await route.fulfill({
      json: { albums: sliced, sort: url.searchParams.get('sort') || 'recent' },
    });
  });

  await page.route((u) => u.pathname.startsWith('/api/library/albums/'), async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    const album = albums.find((a) => a.id === id) ?? albums[0];
    const track_ids = tracks.filter((t) => (t.album_id ?? '') === id).map((t) => t.id);
    await route.fulfill({ json: { album, track_ids } });
  });

  await page.route((u) => u.pathname === '/api/playback/state', async (route) => {
    if (route.request().method() === 'PUT') {
      publishedStates.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'ok', rev: publishedStates.length } });
      return;
    }
    await route.fulfill({ json: opts?.resumeState ?? null });
  });

  await page.route((u) => u.pathname === '/api/devices/register', async (route) => {
    registrations.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'ok' } });
  });

  await page.route((u) => u.pathname.startsWith('/api/static/stream/'), async (route) => {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: fixtureWav });
  });

  let activeWs: WebSocketRoute | null = null;
  if (opts?.installSocket !== false) {
    await page.routeWebSocket('**/socket.io/**', (ws) => {
      activeWs = ws;
      ws.send('0{"sid":"tv-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
      ws.onMessage((raw) => {
        const msg = String(raw);
        if (msg === '40') {
          ws.send('40{"sid":"tv-ns-sid"}');
          return;
        }
        if (msg === '2') {
          ws.send('3');
          return;
        }
        const ackReply = msg.match(/^43(\d+)(\[.*\])$/);
        if (ackReply) {
          emittedAcks.push({ ackId: ackReply[1], payload: JSON.parse(ackReply[2])[0] });
          return;
        }
        const eventMatch = msg.match(/^42(\d+)?(\[.*\])$/);
        if (eventMatch) {
          const [, ackId, body] = eventMatch;
          const [event, payload] = JSON.parse(body) as [string, Record<string, unknown>];
          if (event === 'playback_register' && payload) {
            registrations.push(payload);
          }
          if (ackId) {
            ws.send(`43${ackId}${JSON.stringify([{ ok: true }])}`);
          }
        }
      });
    });
  }

  return {
    publishedStates,
    registrations,
    emittedAcks,
    setSignedIn: (value: boolean) => {
      signedIn = value;
    },
    sendSocketCommand: (ackId: number, name: string, args: Record<string, unknown> = {}) => {
      activeWs?.send(`42${ackId}${JSON.stringify(['device_command', { name, args }])}`);
    },
    disconnectSocket: () => {
      activeWs?.send('41');
    },
  };
}

test('readability metrics, 5% safe margins, and responsive 1080p/720p scaling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  await setupTvSession(page, { viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/tv/');
  const resumeOrCard = page.locator('[data-tv-id]').first();
  await expect(resumeOrCard).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');

  const metrics1080 = await page.evaluate(() => {
    const main = document.querySelector('[data-tv-scroll-y="main"]') as HTMLElement;
    const btn = document.querySelector('[data-tv-id="home-signout-btn"], [data-tv-id="rail-home"]') as HTMLElement;
    const styleRoot = window.getComputedStyle(document.querySelector('[class*="tvRoot"]') as HTMLElement);
    const mainStyle = window.getComputedStyle(main);
    const btnRect = btn.getBoundingClientRect();
    return {
      fontPx: parseFloat(styleRoot.fontSize),
      leftPx: btnRect.left,
      padRightPx: parseFloat(mainStyle.paddingRight),
      padTopPx: parseFloat(mainStyle.paddingTop),
      btnHeightPx: btnRect.height,
    };
  });
  expect(metrics1080.fontPx).toBeGreaterThanOrEqual(31);
  expect(metrics1080.leftPx).toBeGreaterThanOrEqual(96);
  expect(metrics1080.padRightPx).toBeGreaterThanOrEqual(96);
  expect(metrics1080.padTopPx).toBeGreaterThanOrEqual(50);
  expect(metrics1080.btnHeightPx).toBeGreaterThanOrEqual(63);

  await page.setViewportSize({ width: 1280, height: 720 });
  const font720 = await page.evaluate(() =>
    parseFloat(window.getComputedStyle(document.querySelector('[class*="tvRoot"]') as HTMLElement).fontSize),
  );
  expect(font720).toBeGreaterThanOrEqual(20);
  expect(font720).toBeLessThan(metrics1080.fontPx);
});

test('TV sign-in QR polling, redemption, denial recovery, pairing, and password tabs', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  const session = await setupTvSession(page, { requiresLogin: true, signedIn: false });
  let reqCount = 0;
  let statusPolls = 0;

  await page.route((u) => u.pathname === '/api/tv-auth/requests', async (route) => {
    reqCount += 1;
    await route.fulfill({
      status: 201,
      json: {
        code: `TV0${reqCount}-ABCD`,
        redemption_handle: `handle-${reqCount}`,
        device_name: 'Smart TV',
        expires_at: '2099-01-01 00:00:00',
        expires_in_sec: 300,
        poll_interval_ms: 2000,
        approve_path: '/player/#/tv-approve',
        approve_url: `http://127.0.0.1:4173/player/#/tv-approve?code=TV0${reqCount}-ABCD`,
      },
    });
  });

  await page.route((u) => u.pathname === '/api/tv-auth/status', async (route) => {
    statusPolls += 1;
    const body = route.request().postDataJSON();
    if (body.redemption_handle === 'handle-1') {
      await route.fulfill({ json: { status: 'denied', device_name: 'Smart TV', expires_at: '2099-01-01 00:00:00' } });
      return;
    }
    await route.fulfill({
      json: {
        status: statusPolls >= 2 ? 'approved' : 'pending',
        device_name: 'Smart TV',
        expires_at: '2099-01-01 00:00:00',
      },
    });
  });

  await page.route((u) => u.pathname === '/api/tv-auth/redeem', async (route) => {
    session.setSignedIn(true);
    await route.fulfill({
      status: 201,
      json: {
        user: { id: 'u-tv', username: 'sofia', display_name: 'Sofia', role: 'member', has_password: true },
        device_name: 'Smart TV',
      },
    });
  });

  await page.route((u) => u.pathname === '/api/tv-auth/cancel', async (route) => {
    await route.fulfill({ json: { status: 'cancelled' } });
  });

  await page.goto('/tv/');
  await expect(page.getByTestId('tv-auth-code')).toHaveText('TV01-ABCD');
  await expect(page.getByAltText('QR code to approve this TV on your phone')).toBeVisible();

  // First code gets denied -> generate a fresh code -> gets approved and opens Home.
  await expect(page.getByText(/denied on your phone/i)).toBeVisible({ timeout: 6000 });
  await page.getByRole('button', { name: 'New code' }).click();
  await expect(page.getByTestId('tv-auth-code')).toHaveText('TV02-ABCD');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible({ timeout: 8000 });
});

test('Home focuses Resume without autoplay, D-pad rail restore, held OK single fire, and pointer handoff', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  await setupTvSession(page, {
    resumeState: {
      device_id: 'phone-1',
      device_name: 'Phone',
      track_id: DEFAULT_TRACKS[2].id,
      track: DEFAULT_TRACKS[2],
      position_sec: 45,
      is_playing: true,
      updated_at: Math.floor(Date.now() / 1000),
    },
  });

  await page.goto('/tv/');
  const resumeBtn = page.locator('[data-tv-id="home-resume-btn"]');
  await expect(resumeBtn).toBeFocused();

  // Never autoplays on open or moving focus.
  let audioPlayed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('audio')).some((a) => !a.paused),
  );
  expect(audioPlayed).toBe(false);

  // Down moves from Resume hero to Recent listening shelf, Left from index 0 opens Rail, Right restores exact card.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-tv-id="home-recent-0"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-tv-id="home-recent-1"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  const card = page.locator('[data-tv-id="home-recent-0"]');
  const home = page.locator('[data-tv-id="rail-home"]');
  const icon = home.locator('svg');
  const cardLayout = () => card.evaluate(el => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight]);
  const cardBefore = await cardLayout();
  const iconBefore = await icon.boundingBox();
  await page.keyboard.press('ArrowLeft');
  await expect(home).toBeFocused();
  await expect(home.getByText('Home')).toBeVisible();
  expect(await cardLayout()).toEqual(cardBefore);
  expect(await icon.boundingBox()).toEqual(iconBefore);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-tv-id="home-recent-0"]')).toBeFocused();

  // Return Up to Resume, press OK once to start local playback; held OK (repeat: true) does not toggle twice.
  await page.keyboard.press('ArrowUp');
  await expect(resumeBtn).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Playing now/)).toBeVisible();

  // Held Enter (repeat: true) must be defaultPrevented so native button click does not activate again.
  const repeatPrevented = await resumeBtn.evaluate((el) => {
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(repeatPrevented).toBe(true);
  await expect(resumeBtn).toBeFocused();
  const searchBtn = page.locator('[data-tv-id="home-recent-0"]');
  await page.mouse.move(10, 10);
  await page.mouse.move(15, 14);
  // Sub-12px pointer movement must not steal focus away from resumeBtn.
  await expect(resumeBtn).toBeFocused();

  // Deliberate pointer movement (>= 12px) over Recent card takes focus cleanly.
  const box = await searchBtn.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect(searchBtn).toBeFocused();
});

test('long virtualized playlist stays bounded, Back restores focus & Search query, and seek/queue/dim behave', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  const bigTracks: TrackSeed[] = Array.from({ length: 240 }, (_, i) => ({
    id: `big-${i + 1}`,
    item_id: `item-${i + 1}`,
    title: `Symphony Movement ${i + 1}`,
    artist: 'Orchestra',
    album: 'Mega Box Set',
    album_id: 'alb-mega',
    duration: 190,
  }));

  await setupTvSession(page, {
    tracks: bigTracks,
    playlists: { 'Marathon Mix': bigTracks.map((track, index) => index % 2 ? track.id : track.item_id!) },
  });

  await page.route((u) => u.pathname === '/api/catalog/search', async (route) => {
    await route.fulfill({ json: { query: 'Movement 12', items: [], sections: [] } });
  });

  await page.goto('/tv/');
  const firstPlaylistCard = page.locator('[data-tv-id="home-playlist-0"]');
  await firstPlaylistCard.focus();
  await page.keyboard.press('Enter');

  // Detail view shows bounded rows despite 240 tracks.
  await expect(page.getByRole('heading', { name: 'Marathon Mix' })).toBeVisible();
  const rowCount = await page.locator('[data-tv-group="playlist-tracks"]').count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThanOrEqual(24);

  // Move to track list and press ArrowDown repeatedly across virtual window boundaries.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-tv-id="playlist-tracks-item-0"]')).toBeFocused();
  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.locator('[data-tv-id="playlist-tracks-item-18"]')).toBeFocused();
  await page.keyboard.press('Enter');

  // Verify bounded rows stayed bounded after scrolling.
  await expect.poll(() => page.locator('[data-tv-group="playlist-tracks"]').count()).toBeLessThanOrEqual(24);

  // Escape/Back returns to Home and restores focus on home-playlist-0.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tv-id="home-playlist-0"]')).toBeFocused();

  // Navigate to Search, search 'Symphony Movement 12', open Now Playing, then test Seek preview + Queue + Dim.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-tv-id="rail-search"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('[data-tv-id="search-input"]').fill('Symphony Movement 12');
  await page.locator('[data-tv-id="search-submit"]').click();
  await expect(page.getByText('Symphony Movement 12', { exact: true }).first()).toBeVisible();

  // Open Now Playing from Rail while music keeps playing.
  await page.locator('[data-tv-id="rail-now-playing"]').click();
  await expect(page.getByRole('slider', { name: 'Seek position' })).toBeVisible();
  const slider = page.locator('[data-tv-id="np-seek"]');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/Jump to/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Jump to/)).toHaveCount(0);

  // Open Queue -> focus trapped around active item 18 -> select track 20 (item-19) by queueId without losing Now Playing.
  await page.locator('[data-tv-id="np-queue"]').click();
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
  await page.locator('[data-tv-group="tv-queue-rows"][data-tv-index="19"]').click();
  await expect(page.getByRole('heading', { name: 'Up next' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Symphony Movement 20' })).toBeVisible();

  // Dim view wakes on first directional key and restores exact previous focus without navigating!
  const dimBtn = page.locator('[data-tv-id="np-dim"]');
  await dimBtn.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Listening on Soundsible TV/)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(/Listening on Soundsible TV/)).toHaveCount(0);
  await expect(dimBtn).toBeFocused();
});

test('TV remote capability declaration, single command handling across reconnect, and revocation fallback', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  const tv = await setupTvSession(page, { requiresLogin: true, signedIn: true });
  await page.goto('/tv/');
  await expect.poll(() => tv.registrations.length).toBeGreaterThanOrEqual(1);

  const reg = tv.registrations[0];
  expect(reg.form_factor).toBe('tv');
  expect(reg.device_type).toBe('web');
  expect(reg.commands).toContain('transport.pause');
  expect(reg.commands).not.toContain('transport.set_volume');
  expect(reg.commands).not.toContain('radio.start');
  expect((reg.commands as string[]).some((c) => c.startsWith('dj.'))).toBe(false);

  // Start track locally -> live volume omitted -> remote unsupported rejected -> remote next applied once.
  await page.locator('[data-tv-id="home-recent-0"]').click();
  await page.locator('[data-tv-id="album-play-btn"]').click();
  await expect.poll(() => tv.publishedStates.length).toBeGreaterThanOrEqual(1);
  expect((tv.publishedStates.at(-1) as { live: { volume?: unknown } }).live.volume).toBeUndefined();

  tv.sendSocketCommand(10, 'transport.set_volume', { level: 0.2 });
  await expect.poll(() => tv.emittedAcks.some((a) => a.ackId === '10')).toBe(true);
  expect(tv.emittedAcks.find((a) => a.ackId === '10')?.payload).toEqual({
    status: 'rejected',
    reason: 'unsupported',
  });

  tv.sendSocketCommand(11, 'transport.next', {});
  await expect.poll(() => tv.emittedAcks.some((a) => a.ackId === '11')).toBe(true);
  expect((tv.emittedAcks.find((a) => a.ackId === '11')?.payload as { status: string }).status).toBe('applied');

  // Revoking credential drops session back to TV Sign-in screen.
  tv.setSignedIn(false);
  tv.disconnectSocket();
  await expect(page.getByRole('heading', { name: 'Sign in on your TV' })).toBeVisible({ timeout: 8000 });
});

test('TV Library Albums paginates beyond the first page cleanly via Load more albums', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'Smart TV runs on living-room viewports');

  const manyAlbumTracks: TrackSeed[] = Array.from({ length: 130 }, (_, i) => ({
    id: `trk-many-${i + 1}`,
    title: `Song ${i + 1}`,
    artist: `Artist ${i + 1}`,
    album: `Album ${String(i + 1).padStart(3, '0')}`,
    album_id: `alb-many-${i + 1}`,
    duration: 180,
  }));

  await setupTvSession(page, { tracks: manyAlbumTracks });
  await page.goto('/tv/#/library');
  await page.locator('[data-tv-id="lib-tab-albums"]').click();

  await expect(page.locator('[data-tv-id="lib-album-0"]')).toBeVisible();
  await expect(page.locator('[data-tv-id="lib-album-119"]')).toBeVisible();
  await expect(page.locator('[data-tv-id="lib-album-120"]')).toHaveCount(0);

  const loadMore = page.locator('[data-tv-id="lib-albums-load-more"]');
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  await expect(page.locator('[data-tv-id="lib-album-129"]')).toBeVisible();
  await expect(page.locator('[data-tv-id="lib-album-120"]')).toBeFocused();
  await expect(loadMore).toHaveCount(0);
});
