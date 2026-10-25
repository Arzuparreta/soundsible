import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mockMusicEngine } from './music-browser-fixture';

const vectors = JSON.parse(readFileSync(new URL('../../../shared/contracts/dj_echo_plans.json', import.meta.url), 'utf8'));

test('the real Web Audio echo repeats impulses on the server beat at both output rates', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/');
  const results = await page.evaluate(async (cases) => {
    const graphPath = '/player/src/lib/audio/graph.ts';
    const lifetimePath = '/player/src/lib/runtimeLifetime.ts';
    const { createGraph } = await import(graphPath);
    const { RuntimeLifetime } = await import(lifetimePath);
    const OriginalContext = globalThis.AudioContext;
    const results = [];
    try {
      for (const vector of cases) for (const rate of [44100, 48000]) for (const speed of [1, 1.04]) {
        const delay = vector.transition.echo_delay_seconds / speed;
        const context = new OfflineAudioContext(2, Math.ceil((0.2 + delay * 3) * rate), rate);
        const sources: AudioBufferSourceNode[] = [];
        // Known PCM enters at the normal media-source boundary. Everything
        // after it is graph.ts and the browser's actual audio nodes.
        Object.assign(context, {
          resume: async () => {},
          createBiquadFilter: undefined,
          createMediaElementSource: () => {
            const source = context.createBufferSource();
            const buffer = context.createBuffer(2, 1, rate);
            buffer.getChannelData(0)[0] = sources.length === 0 ? 0.5 : 0;
            buffer.getChannelData(1)[0] = sources.length === 0 ? -0.5 : 0;
            source.buffer = buffer;
            sources.push(source);
            return source;
          },
        });
        globalThis.AudioContext = function () { return context; } as unknown as typeof AudioContext;
        const decks = [new Audio(), new Audio()];
        const lifetime = new RuntimeLifetime();
        const graph = createGraph({
          elements: decks, decks: () => decks, activeIndex: 0, pendingSeeks: new WeakMap(),
          playbackRequested: false, broadcastCapture: null, VOLUME_KEY: 'echo-test-volume',
          applyDeckMute() {}, configurePlaybackSession() {}, reconcilePlatformPlayback() {},
          unlockDecks() {}, resetClockSample() {}, releaseBroadcastCapture() {},
        }, lifetime);
        if (!graph.unlockAudio()) throw new Error('Graph did not initialize');
        graph.setDeckLevel(0, 0.5);
        graph.setDeckGain(0, 0);
        graph.ensureEcho(0, delay);
        const wet = graph.deckEffects[0].echoWet;
        // Observe the return before the programme limiter's lookahead.
        wet.disconnect(); wet.connect(context.destination); wet.gain.value = 0.32;
        sources.forEach(source => source.start(0.1));
        const rendered = await context.startRendering();
        const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
        for (let repeat = 1; repeat <= 3; repeat++) {
          const expectedFrame = Math.round((0.1 + repeat * 60 / vector.bpm / speed) * rate);
          let amplitude = 0, inverse = 0, peak = 0, peakFrame = 0;
          for (let frame = expectedFrame - 8; frame <= expectedFrame + 8; frame++) {
            amplitude += left[frame]; inverse += right[frame];
            if (Math.abs(left[frame]) > peak) { peak = Math.abs(left[frame]); peakFrame = frame; }
          }
          results.push({ name: vector.name, rate, speed, repeat,
            errorFrames: Math.abs(peakFrame - expectedFrame), amplitude, inverse,
            expectedAmplitude: 0.08 * 0.32 ** (repeat - 1) });
        }
        lifetime.close(); graph.dispose();
      }
    } finally { globalThis.AudioContext = OriginalContext; }
    return results;
  }, vectors);
  console.log(JSON.stringify({ repetitions: results.length,
    maxErrorFrames: Math.max(...results.map(result => result.errorFrames)) }));
  for (const result of results) {
    expect(result.errorFrames, JSON.stringify(result)).toBeLessThanOrEqual(3);
    expect(result.amplitude, JSON.stringify(result)).toBeCloseTo(result.expectedAmplitude, 4);
    expect(result.inverse, JSON.stringify(result)).toBeCloseTo(-result.expectedAmplitude, 4);
  }
});
