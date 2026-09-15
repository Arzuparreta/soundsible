import { expect, type Page } from '@playwright/test';

export const TRACKS = Array.from({ length: 320 }, (_, index) => ({
  id: `library-track-${index + 1}`,
  title: `Canción de biblioteca ${index + 1}`,
  artist: `Artista ${index % 24}`,
  album: 'Biblioteca de prueba',
  duration: 180,
}));

export async function mockMusicEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: { id: 'library-qa', username: 'library-qa', display_name: 'Library QA', role: 'admin', has_password: true },
      };
    } else if (path === '/api/library') {
      body = { tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [] };
    } else if (path === '/api/devices' || path === '/api/paired-devices' || path === '/api/pairing/sessions') {
      body = { devices: [], sessions: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await silentStream(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('music-fixture-initialized')) {
      localStorage.clear();
      sessionStorage.setItem('music-fixture-initialized', 'true');
    }
    localStorage.setItem('lang', 'es');
    localStorage.setItem('soundsible:interface-size', 'normal');
  });
}

/**
 * Serve every track as a long, real, silent WAV.
 *
 * Without this the engine gets audio it cannot play, treats each track as
 * finished and walks the queue: three seconds after pressing play on track 320
 * the mini player reads 317, then 316. That moves the player's own title text,
 * so the pill it lives in changes width about once a second, forever.
 *
 * Playwright will not click a moving target — `click()` waits for the element
 * to be "visible, enabled and stable" — so a click on the pill never becomes
 * actionable, spends the full 30s test budget, and the teardown that follows
 * makes the pending click report "Target page, context or browser has been
 * closed". That reads like a browser crash and is not one. It is why
 * additional-themes, music-explorer and player-panel-swipe all flake in the
 * same place.
 *
 * Three minutes of silence outlasts any test, so playback simply stays put.
 * Register it before a spec's own stream route, which then takes precedence.
 *
 * It is also the only audio the Linux WebKit builds survive. Handed the MP3
 * fixture instead, the WebProcess dies outright the first time the transport
 * pauses: reproduced in the `mcr.microsoft.com/playwright:v1.62.0-noble`
 * image, 5 of 8 runs of `playback-feedback` against MP3 versus 0 of 8 against
 * this WAV, and the same 3 of 8 when the MP3 is served with `Accept-Ranges`
 * and 206s, which rules the transport out and leaves the GStreamer decode
 * path. Only reach for the MP3 where the format is the thing under test.
 */
export const silentWav = (() => {
  const samples = 8000 * 180;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
})();

export async function silentStream(page: Page): Promise<void> {
  await page.route('**/api/static/stream/**', (route) => route.fulfill({ contentType: 'audio/wav', body: silentWav }));
}

/**
 * Open the player from its mini-player pill. Scoped to the pill so it names the
 * one button it means, rather than picking it out of the page by position.
 */
export async function openMiniPlayer(page: Page, name: RegExp): Promise<void> {
  const pill = page.locator('[data-omni-player]');
  await expect(pill).toBeVisible();
  await pill.getByRole('button', { name }).click();
}

export async function openMusicPlayer(page: Page) {
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await openMiniPlayer(page, /^NORMAL:/);
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
}
