/** Decision-gate characterization, not a guarantee that one-shot refinement
 * should be preserved. Update this evidence if a retry contract is introduced.
 * Real app/store/audio in Chromium; controlled API, silent local WAV. */
import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, silentWav, TRACKS } from './music-browser-fixture';

for (const initiallyReady of [false, true]) {
  test(`audit: refinement consumes only the first response (initially ready: ${initiallyReady})`, async ({ page }) => {
    await mockMusicEngine(page);
    await page.route('**/api/static/stream/**', async (route) => {
      const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), silentWav.length - 1) : silentWav.length - 1;
      await route.fulfill({ status: match ? 206 : 200, contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
          ...(match ? { 'Content-Range': `bytes ${start}-${end}/${silentWav.length}` } : {}) },
        body: silentWav.subarray(start, end + 1) });
    });
    let ready = initiallyReady;
    let refinements = 0;
    await page.route('**/api/discovery/music/dj-plan', async (route) => {
      const request = route.request().postDataJSON();
      await route.fulfill({ json: {
        v: 6, plan_id: 'queue-audit', intent: 'auto_mode', profile: 'balanced',
        seed_identity: request.seed?.id, direction_revision: request.direction_revision,
        items: TRACKS.slice(0, 8).map((row) => ({
          ...row, track_id: row.id, source: 'library', source_pool: 'local', recommendation_identity: `music:track:${row.id}`,
          transition: { technique: 'fade', confidence: 0.18, out_cue: 165, overlap_seconds: 8 },
        })),
        pool_counts: { local: 8, related: 0, discovery: 0 }, generated_at: 1,
      } });
    });
    await page.route('**/api/discovery/music/dj-transition', async (route) => {
      refinements += 1;
      await route.fulfill({ json: {
        measured: ready,
        transition: { technique: ready ? 'long_blend' : 'fade', confidence: ready ? 0.95 : 0.18,
          out_cue: 165, overlap_seconds: 8 },
      } });
    });
    await openMusicPlayer(page);
    await page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { actions } = await import(/* @vite-ignore */ modulePath);
      actions.enterAutoMode();
    });
    await expect.poll(() => page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { state } = await import(/* @vite-ignore */ modulePath);
      return state.playback.queue.length;
    })).toBe(9);
    await expect.poll(() => page.evaluate(async () => {
      const modulePath = '/player/src/lib/audio.ts';
      const { audioEl } = await import(/* @vite-ignore */ modulePath);
      return audioEl().readyState;
    })).toBeGreaterThanOrEqual(3);
    // Seek into refinement's 20-second window, before the commit point.
    await page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { actions } = await import(/* @vite-ignore */ modulePath);
      actions.seek(108);
    });
    await expect.poll(() => refinements).toBe(1);
    ready = true;
    for (const position of [109, 111, 113]) {
      await page.evaluate(async (value) => {
        const modulePath = '/player/src/stores/index.ts';
        const { actions } = await import(/* @vite-ignore */ modulePath);
        actions.seek(value);
      }, position);
      await expect.poll(() => page.evaluate(async () => {
        const modulePath = '/player/src/stores/index.ts';
        const { state } = await import(/* @vite-ignore */ modulePath);
        return state.playback.currentTime;
      })).toBeGreaterThanOrEqual(position);
    }
    const observation = await page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { state } = await import(/* @vite-ignore */ modulePath);
      const next = state.playback.queue[state.playback.index + 1];
      return { currentId: state.playback.currentTrack?.id,
        transition: state.autoMode.plan[next.queueId]?.transition };
    });
    expect(refinements).toBe(1);
    expect(observation.currentId).toBe(TRACKS[319].id);
    expect(observation.transition.confidence).toBe(initiallyReady ? 0.95 : 0.18);
    await test.info().attach('refinement-observation.json', {
      body: JSON.stringify({ initiallyReady, refinements, serverReadyAfterFirstResponse: ready, ...observation }),
      contentType: 'application/json',
    });
  });
}
