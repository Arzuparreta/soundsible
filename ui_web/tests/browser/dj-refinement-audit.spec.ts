/** Real app/store/audio, controlled API and silent WAV: pending analysis must
 * be retried before the seam is committed, and stop once it is measured. */
import { expect, test } from '@playwright/test';
import { mockMusicEngine, openMusicPlayer, fixtureWav, TRACKS } from './music-browser-fixture';

for (const initiallyReady of [false, true]) {
  test(`refinement retries until measured (initially ready: ${initiallyReady})`, async ({ page }) => {
    await mockMusicEngine(page);
    await page.route('**/api/static/stream/**', async (route) => {
      const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), fixtureWav.length - 1) : fixtureWav.length - 1;
      await route.fulfill({ status: match ? 206 : 200, contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
          ...(match ? { 'Content-Range': `bytes ${start}-${end}/${fixtureWav.length}` } : {}) },
        body: fixtureWav.subarray(start, end + 1) });
    });
    let ready = initiallyReady;
    let refinements = 0;
    await page.route('**/api/discovery/music/dj-plan', async (route) => {
      const request = route.request().postDataJSON();
      await route.fulfill({ json: {
        v: 6, plan_id: 'queue-audit', intent: 'auto_mode', profile: 'balanced',
        seed_identity: request.seed?.id, direction_revision: request.direction_revision,
        seed_analysis: { analysed: false },
        analysis_coverage: { candidates: 8, analysed: 0, cohort: 8, cohort_analysed: 0, bridges: 0 },
        items: TRACKS.slice(0, 8).map((row) => ({
          ...row, track_id: row.id, source: 'library', source_pool: 'local', recommendation_identity: `music:track:${row.id}`,
          transition: { technique: 'fade', confidence: 0.18, out_cue: 165, overlap_seconds: 8 },
          analysis: { analysed: false },
        })),
        pool_counts: { local: 8, related: 0, discovery: 0 }, generated_at: 1,
      } });
    });
    await page.route('**/api/discovery/music/dj-transition', async (route) => {
      refinements += 1;
      await route.fulfill({ json: {
        measured: ready,
        analysis: { from: { analysed: ready }, to: { analysed: ready } },
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
    await expect.poll(async () => page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { state } = await import(/* @vite-ignore */ modulePath);
      const next = state.playback.queue[state.playback.index + 1];
      return state.autoMode.plan[next.queueId]?.transition?.confidence;
    })).toBe(0.95);
    const observation = await page.evaluate(async () => {
      const modulePath = '/player/src/stores/index.ts';
      const { state } = await import(/* @vite-ignore */ modulePath);
      const next = state.playback.queue[state.playback.index + 1];
      return { currentId: state.playback.currentTrack?.id,
        transition: state.autoMode.plan[next.queueId]?.transition };
    });
    expect(refinements).toBe(initiallyReady ? 1 : 2);
    expect(observation.currentId).toBe(TRACKS[319].id);
    expect(observation.transition.confidence).toBe(0.95);
    const evidence = await page.evaluate(async () => {
      const path = '/player/src/lib/playbackDiagnostics.ts';
      const { playbackDiagnosticExport } = await import(/* @vite-ignore */ path);
      return JSON.parse(playbackDiagnosticExport()).events as Array<{ event: string; facts: Record<string, unknown> }>;
    });
    const selected = evidence.find(row => row.event === 'dj.selected')!;
    const refined = evidence.find(row => row.event === 'dj.refined' && row.facts.accepted === true)!;
    expect(evidence.find(row => row.event === 'dj.session_started')?.facts.startKnown).toBe(true);
    expect(selected.facts.fromAnalysed).toBe(false);
    expect(refined.facts).toMatchObject({ djSession: selected.facts.djSession, edgeId: selected.facts.edgeId,
      fromAnalysed: true, toAnalysed: true });
    expect(JSON.stringify(evidence.filter(row => row.event.startsWith('dj.')))).not.toContain('library-track-');
    await test.info().attach('refinement-observation.json', {
      body: JSON.stringify({ initiallyReady, refinements, serverReadyAfterFirstResponse: ready, ...observation }),
      contentType: 'application/json',
    });
  });
}
