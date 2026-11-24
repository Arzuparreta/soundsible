import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { fixtureWav, mockMusicEngine } from './music-browser-fixture';

for (const keys of [['yt:dQw4w9WgXcQ'], ['deezer:42']]) {
  test(`send a saved song without downloading or playing it locally (${keys[0]})`, async ({ page }) => {
    await mockMusicEngine(page);
    await page.route(url => url.pathname === '/api/library', route => route.fulfill({ json: { tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] } }));
    await page.route(url => url.pathname === '/api/library/saved', route => route.fulfill({ json: { saved: [{ keys, title: 'Canción remota', artist: 'Artista remoto' }] } }));
    await page.route('**/api/devices', route => route.fulfill({ json: { devices: [{ device_id: 'other-device', device_name: 'Portátil', online: true, socket_active: true }] } }));
    const commands: Array<Record<string, any>> = [];
    await page.route('**/api/devices/other-device/commands', async route => {
      commands.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'applied', rev: 1 } });
    });
    const acquired: string[] = [];
    page.on('request', request => {
      if (/\/api\/preview\/stream/.test(request.url()) || /\/api\/downloader\/queue/.test(request.url()) && request.method() === 'POST') acquired.push(request.url());
    });
    await page.goto('/player/#/library?view=songs');
    const row = page.locator('[data-music-list-row], [data-song-row]').filter({ hasText: 'Canción remota' });
    await row.getByRole('button', { name: /^Más opciones/ }).click();
    await page.getByText('Reproducir en dispositivo', { exact: true }).click();
    await page.getByRole('button', { name: /^Portátil/ }).click();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toMatchObject({
      name: 'play.tracks',
      args: { index: 0, tracks: [{ title: 'Canción remota', artist: 'Artista remoto', source: 'preview', originKeys: keys }] },
    });
    const sent = commands[0].args.tracks[0];
    if (keys[0].startsWith('yt:')) expect(sent.id).toBe('dQw4w9WgXcQ');
    else expect(sent.pendingResolve).toMatchObject({ catalogItemId: keys[0], artist: 'Artista remoto', title: 'Canción remota' });
    expect(acquired).toEqual([]);
  });
}

/** Minimal Engine.IO v4 / Socket.IO v4 WebSocket stub for connected-mode specs. */
async function stubSocketIo(
  page: Page,
  onWatch: (deviceId: string) => Record<string, unknown>,
) {
  let activeWs: WebSocketRoute | null = null;
  await page.routeWebSocket('**/socket.io/**', (ws) => {
    activeWs = ws;
    ws.send('0{"sid":"stub-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    ws.onMessage((raw) => {
      const msg = String(raw);
      if (msg === '40') {
        ws.send('40{"sid":"ns-sid"}');
        return;
      }
      if (msg === '2') {
        ws.send('3');
        return;
      }
      // Socket.IO event with ack id: `42<ackId>["event",payload]`
      const ackMatch = msg.match(/^42(\d+)(\[.*\])$/);
      if (ackMatch) {
        const [, ackId, body] = ackMatch;
        const [event, payload] = JSON.parse(body) as [string, Record<string, unknown>];
        if (event === 'watch_device' && typeof payload?.device_id === 'string') {
          ws.send(`43${ackId}${JSON.stringify([onWatch(payload.device_id)])}`);
        } else if (event === 'unwatch_device') {
          ws.send(`43${ackId}${JSON.stringify([{ ok: true }])}`);
        }
      }
    });
  });
  return {
    emit: (event: string, payload: unknown) => {
      activeWs?.send(`42${JSON.stringify([event, payload])}`);
    },
  };
}

test('connected mode: device sheet, controlling remote playback, capability hiding, and offline recovery', async ({ page }) => {
  await mockMusicEngine(page);
  const remoteTrack = { id: 'track-1', title: 'Pista 1', artist: 'Artista Uno', album: 'Álbum Uno', duration: 210 };
  const secondTrack = { id: 'track-2', title: 'Pista 2', artist: 'Artista Dos', album: 'Álbum Dos', duration: 195 };
  const now = Date.now();
  const speakerDevice = {
    device_id: 'speaker-1',
    device_name: 'Altavoz Salón',
    device_type: 'android',
    form_factor: 'phone',
    online: true,
    socket_active: true,
    protocol: 1,
    // Omit transport.set_volume to verify remote volume controls stay hidden.
    commands: ['transport.play', 'transport.pause', 'transport.next', 'transport.previous', 'transport.seek', 'play.tracks', 'queue.add'],
    playing: { track: remoteTrack, is_playing: true, position_sec: 30, measured_at_ms: now, mode: 'normal', rev: 2 },
  };
  const outdatedDevice = {
    device_id: 'legacy-1',
    device_name: 'Móvil antiguo',
    device_type: 'android',
    form_factor: 'phone',
    online: true,
    socket_active: true,
    protocol: null,
    commands: [],
    playing: null,
  };
  const commands: Array<{ name: string; args: Record<string, unknown> }> = [];
  const audioRequests: string[] = [];

  page.on('request', (req) => {
    if (/\/api\/static\/stream\//.test(req.url())) audioRequests.push(req.url());
  });

  await page.route('**/api/devices', (route) =>
    route.fulfill({ json: { devices: [speakerDevice, outdatedDevice], server_now_ms: Date.now() } }),
  );
  await page.route('**/api/devices/speaker-1/commands', async (route) => {
    const body = route.request().postDataJSON();
    commands.push(body);
    await route.fulfill({ json: { status: 'applied', rev: commands.length + 2 } });
  });

  const sock = await stubSocketIo(page, (deviceId) => ({
    device: deviceId === 'speaker-1' ? speakerDevice : null,
    server_now_ms: Date.now(),
    state: deviceId === 'speaker-1'
      ? {
          device_id: 'speaker-1',
          rev: 2,
          track_id: remoteTrack.id,
          track: remoteTrack,
          position_sec: 30,
          is_playing: true,
          measured_at_ms: Date.now(),
          live: { phase: 'playing', duration: 210, dj: null },
          session: {
            v: 1,
            mode: 'now_playing',
            queue: [
              { ...remoteTrack, queueId: 'q1', queueLane: 'context', queueSource: 'album' },
              { ...secondTrack, queueId: 'q2', queueLane: 'context', queueSource: 'album' },
            ],
            index: 0,
            shuffle: false,
            repeat: 'off',
            radio: { active: false, seedId: null },
            auto: null,
          },
        }
      : null,
  }));

  await page.goto('/player/#/settings/devices');
  const mobile = (page.viewportSize()?.width ?? 1280) < 1024;
  const sheet = page.locator('[data-connect-sheet]');
  await page.getByRole('button', { name: 'Dispositivos de reproducción' }).click();
  await expect(sheet.getByRole('radio', { name: /Este dispositivo/ })).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('radio', { name: /Altavoz Salón/ }).click();
  await page.evaluate(() => { window.location.hash = '/library?view=songs'; });
  const omni = page.locator('[data-omni-player]');
  await expect(omni).toContainText('Pista 1');
  await expect(omni).toContainText('Altavoz Salón');
  if (!mobile) {
    await expect(omni.locator('[data-device-trigger="omnibar"]')).toContainText('Altavoz Salón');
    // Remote Android target does not declare transport.set_volume -> volume slider hidden.
    await expect(omni.getByLabel('Volumen')).toHaveCount(0);
  }

  // Clicking pause sends transport.pause remotely.
  await omni.getByRole('button', { name: 'Pausar' }).click();
  await expect.poll(() => commands.some((c) => c.name === 'transport.pause')).toBe(true);
  sock.emit('device_state', {
    device_id: 'speaker-1',
    rev: 3,
    track_id: remoteTrack.id,
    track: remoteTrack,
    position_sec: 31,
    is_playing: false,
    measured_at_ms: Date.now(),
    server_now_ms: Date.now(),
    live: { phase: 'paused', duration: 210, dj: null },
  });
  await expect(omni.getByRole('button', { name: 'Reproducir' })).toBeVisible();

  // Tapping a song in Library plays it on the controlled device without streaming locally.
  const firstLibraryPlay = page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ });
  await firstLibraryPlay.click();
  await expect.poll(() => commands.some((c) => c.name === 'play.tracks')).toBe(true);
  expect(audioRequests).toEqual([]);

  // Open Now Playing -> verify "Sonando en Altavoz Salón" and open Device Sheet from header.
  const remotePillBox = mobile ? await omni.boundingBox() : null;
  await omni.locator('button').first().click();
  const surface = page.locator('[data-player-surface-open]');
  await expect(surface).toBeVisible();
  if (mobile) {
    await expect(surface.locator('[data-device-trigger="player-banner"]')).toContainText('Sonando en Altavoz Salón');
    await surface.locator('[data-device-trigger="player-banner"]').click();
  } else {
    await expect(surface.locator('[data-device-trigger="player-header"]')).toContainText('Sonando en Altavoz Salón');
    await surface.locator('[data-device-trigger="player-header"]').click();
  }

  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('radio', { name: /Altavoz Salón/ })).toHaveAttribute('aria-checked', 'true');
  const deviceAction = sheet.getByRole('button', { name: 'Copiar pista' });
  await expect(deviceAction).toBeVisible();
  const [rowBox, actionBox] = await Promise.all([
    sheet.getByRole('radio', { name: /Altavoz Salón/ }).boundingBox(), deviceAction.boundingBox(),
  ]);
  expect(actionBox!.x).toBeGreaterThanOrEqual(rowBox!.x + rowBox!.width);
  expect(actionBox!.y).toBeLessThan(rowBox!.y + rowBox!.height);
  sock.emit('device_updated', { device: { ...speakerDevice, playing: { ...speakerDevice.playing, mode: 'dj', rev: 4 } }, server_now_ms: Date.now() });
  await expect(sheet.getByRole('button', { name: 'Mover DJ aquí' })).toBeVisible();
  await expect(deviceAction).toHaveCount(0);
  await expect(sheet.locator('[data-device-outdated="legacy-1"]')).toContainText('Actualiza Soundsible en este dispositivo para controlarlo');

  // Close sheet with Escape and close Now Playing.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await surface.getByRole('button', { name: 'Cerrar' }).click();

  // Return to normal before testing the local and remote normal-player pill.
  sock.emit('device_updated', { device: { ...speakerDevice, playing: { ...speakerDevice.playing, rev: 5 } }, server_now_ms: Date.now() });

  // Controlled device goes offline -> pill shows unreachable; tapping opens sheet with Try again & Use this device.
  sock.emit('device_updated', { device: { ...speakerDevice, playing: { ...speakerDevice.playing, rev: 5 }, online: false, socket_active: false }, server_now_ms: Date.now() });
  await expect(omni).toContainText('Altavoz Salón no está accesible');
  if (mobile) {
    await omni.locator('button').first().click();
  } else {
    await omni.locator('[data-device-trigger="omnibar"]').click();
  }
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('alert')).toContainText('Altavoz Salón no está accesible');
  await expect(sheet.getByRole('button', { name: 'Intentar de nuevo' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Usar este dispositivo' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(omni).not.toContainText('Altavoz Salón');

  // On phone, playing locally shows the same mini-player pill height as remote mode.
  if (mobile && remotePillBox) {
    await firstLibraryPlay.click();
    await expect(omni).toBeVisible();
    const localPillBox = await omni.boundingBox();
    expect(localPillBox).not.toBeNull();
    expect(Math.abs(localPillBox!.height - remotePillBox.height)).toBeLessThanOrEqual(0.5);
  }
});


test('a fresh player stays local and can copy a remote track without sending a command', async ({ page }) => {
  await mockMusicEngine(page);
  await page.addInitScript(() => {
    localStorage.setItem('remote:target', 'speaker-1');
    sessionStorage.setItem('music-fixture-initialized', 'true');
  });
  const remoteTrack = { id: 'remote-song', title: 'Pista del otro dispositivo', artist: 'Artista remoto', duration: 180 };
  const now = Date.now();
  const remote = {
    device_id: 'speaker-1', device_name: 'ThinkPad', online: true, protocol: 1, form_factor: 'computer',
    playing: { track: remoteTrack, is_playing: true, position_sec: 30, measured_at_ms: now, mode: 'normal', rev: 1 },
  };
  const peerWrites: string[] = [];
  const localPublishes: Array<{ track_id: string; position_sec: number; is_playing: boolean }> = [];
  await page.route('**/api/devices', route => route.fulfill({ json: { devices: [remote], server_now_ms: Date.now() } }));
  await page.route('**/api/devices/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && (/\/commands$/.test(path) || path === '/api/devices/transfer')) peerWrites.push(path);
    return route.fulfill({ json: { status: 'applied', rev: 2 } });
  });
  await page.route('**/api/playback/state**', route => {
    if (route.request().method() === 'PUT') localPublishes.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'ok', rev: 1 } });
  });
  await stubSocketIo(page, () => ({ device: remote, state: null }));

  await page.goto('/player/#/library?view=songs');
  const firstLocalStream = page.waitForRequest('**/api/static/stream/library-track-320**');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await firstLocalStream;
  await page.evaluate(() => { window.location.hash = '/settings/devices'; });
  await page.getByRole('button', { name: 'Dispositivos de reproducción' }).click();
  const sheet = page.locator('[data-connect-sheet]');
  await expect(sheet.getByRole('radio', { name: /Este dispositivo/ })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.getByRole('radio', { name: /ThinkPad/ })).toContainText('Pista del otro dispositivo');
  // Core serves byte ranges. A plain WAV response starts at zero on Chromium.
  await page.route('**/api/static/stream/remote-song**', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const headers = { 'accept-ranges': 'bytes' };
    if (!range) return route.fulfill({ headers, contentType: 'audio/wav', body: fixtureWav });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), fixtureWav.length - 1) : fixtureWav.length - 1;
    return route.fulfill({
      status: 206, contentType: 'audio/wav', body: fixtureWav.subarray(start, end + 1),
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${fixtureWav.length}` },
    });
  });
  const copiedStream = page.waitForRequest('**/api/static/stream/remote-song**');
  await sheet.getByRole('button', { name: 'Copiar pista' }).click();
  await copiedStream;
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-omni-player]')).toContainText('Pista del otro dispositivo');
  await expect.poll(() => localPublishes.some(({ track_id, position_sec, is_playing }) =>
    track_id === remoteTrack.id && position_sec >= 30 && is_playing)).toBe(true);
  expect(peerWrites).toEqual([]);
});
