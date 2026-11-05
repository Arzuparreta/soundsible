import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

// A 120 BPM outgoing and a 132 BPM incoming song meet at 125.71 BPM: each
// deck 4.76 % from normal speed. The incoming deck alone would need 9.1 %,
// beyond the players' range. Known clicks at different pitches go through
// the real mixer, renderer time-stretching and gain graph; the recorded
// programme output says where each kick actually sounded.
const RATE = 44100;
const OUT_BPM = 120;
const FIRST = 0.25;
// The incoming deck alone (as before shared tempo), and both decks.
const CASES = [
  { name: 'incoming deck alone', inBpm: 126, split: false },
  { name: 'both decks at a shared tempo', inBpm: 132, split: true },
];
const OUT_TONE = 1000, IN_TONE = 3000;

function clicks(bpm: number, tone: number, seconds: number): Buffer {
  const samples = Math.round(seconds * RATE);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  // A quiet continuous bed: the mixer requires sounding PCM from a deck
  // (P16), and a bare click train is silent between kicks.
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(300 * Math.sin(2 * Math.PI * tone / 8 * i / RATE)), 44 + i * 2);
  const burst = Math.round(0.004 * RATE);
  for (let beat = FIRST; beat < seconds - 0.1; beat += 60 / bpm) {
    const start = Math.round(beat * RATE);
    for (let i = 0; i < burst; i++) {
      const window = Math.sin(Math.PI * i / burst) ** 2;
      wav.writeInt16LE(Math.round(16000 * window * Math.sin(2 * Math.PI * tone * i / RATE)), 44 + (start + i) * 2);
    }
  }
  return wav;
}

for (const { name, inBpm: IN_BPM, split } of CASES) test(`kicks sound together: ${name}`, async ({ page, browserName }) => {
  // Measured in the Playwright image: its GStreamer WebKit drops any element
  // to HAVE_CURRENT_DATA (readyState 4 → 2) at a playbackRate other than 1,
  // and keeps it there back at 1×, so the mixer never admits a stretched
  // deck. The iPhone's WebKit keeps readyState 4 through rate ramps (P15).
  test.skip(browserName === 'webkit', 'GStreamer WebKit reports readyState 2 at any playbackRate other than 1');
  test.setTimeout(90_000);
  await mockMusicEngine(page);
  const files: Record<string, Buffer> = { out: clicks(OUT_BPM, OUT_TONE, 40), in: clicks(IN_BPM, IN_TONE, 40) };
  // Served with byte ranges: WebKit keeps a whole-body response at
  // HAVE_CURRENT_DATA, which the mixer rightly refuses to fade into.
  await page.route('**/shared-tempo/*.wav', route => {
    const body = files[new URL(route.request().url()).pathname.split('/').pop()!.replace('.wav', '')];
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    if (!range) return route.fulfill({ contentType: 'audio/wav', body, headers: { 'Accept-Ranges': 'bytes' } });
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav', body: body.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` } });
  });
  await page.goto('/player/');
  const relation = OUT_BPM / IN_BPM;
  const outRate = split ? 2 / (1 + relation) : 1;
  const outBeat = 60 / OUT_BPM, inBeat = 60 / IN_BPM;
  const plan = {
    technique: 'bass_swap', out_cue: FIRST + 24 * outBeat, in_cue: FIRST + 2 * inBeat, overlap_seconds: 6,
    overlap_bars: 3, playback_rate: relation, confidence: .9, sync: { phase_tolerance_ms: 5 },
    // A shorter ramp than the planner's, with the same slope limit.
    ...(split ? { out_playback_rate: outRate, out_rate_ramp: { lead_seconds: 7, seconds: 3 } } : {}),
  };
  const ramp = { lead_seconds: 7, seconds: 3 };
  await page.evaluate(({ plan, outTone, inTone }) => {
    const button = document.createElement('button');
    button.textContent = 'Probar tempo compartido';
    const recorded: Float32Array[] = [];
    let rate = 0;
    button.onclick = async () => {
      try {
        const path = '/player/src/lib/audio.ts';
        const diagnosticsPath = '/player/src/lib/playbackDiagnostics.ts';
        const diagnostics = await import(diagnosticsPath);
        try { diagnostics.startPlaybackDiagnostics({ userId: 'qa', deviceId: 'qa', platform: 'test', displayMode: 'browser' }); } catch { /* The app already records. */ }
        const { audioService, audioEl } = await import(path);
        audioService.unlockAudio();
        await audioService.load('/shared-tempo/out.wav', 1, 0);
        const outgoing = audioEl() as HTMLAudioElement;
        // The programme as Live listeners receive it: both decks after the
        // faders, effects and limiter. One stream keeps their relative timing.
        const stream = audioService.acquireBroadcastCapture()?.stream;
        if (!stream) throw new Error('no programme capture');
        const recorder = new AudioContext();
        await recorder.resume();
        rate = recorder.sampleRate;
        const tap = recorder.createScriptProcessor(4096, 1, 1);
        tap.onaudioprocess = event => recorded.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        recorder.createMediaStreamSource(stream).connect(tap).connect(recorder.destination);
        await new Promise<void>(resolve => { const wait = () => outgoing.currentTime > 0.05 ? resolve() : setTimeout(wait, 20); wait(); });
        let finalIn = 0;
        const log: string[] = [];
        (window as unknown as { __log: string[] }).__log = log;
        const done = new Promise<void>((resolve, reject) => audioService.armTransition('/shared-tempo/in.wav', plan, {
          onDominant: () => {}, onComplete: () => { finalIn = (audioEl() as HTMLAudioElement).playbackRate; resolve(); }, onCancel: (reason: string) => reject(new Error(reason)),
          onError: (error: unknown) => reject(error), onStaged: () => reject(new Error('staged')),
        }, { level: 1 }));
        const speeds: Array<[number, number]> = [];
        const sampler = setInterval(() => {
          speeds.push([outgoing.currentTime, outgoing.playbackRate]);
          const snap = audioService.programMixSnapshot();
          log.push(`${outgoing.currentTime.toFixed(2)} ${snap.phase} ${snap.decks.map((d: { position: number; gain: number }) => d.position.toFixed(2) + '/' + d.gain.toFixed(2)).join(' ')}`);
        }, 250);
        await done;
        clearInterval(sampler);
        await new Promise(resolve => setTimeout(resolve, 300));
        audioService.stop();
        await recorder.close();
        // Envelope of each click tone, then the first onset after silence.
        const pcm = new Float32Array(recorded.reduce((sum, block) => sum + block.length, 0));
        let offset = 0;
        for (const block of recorded) { pcm.set(block, offset); offset += block.length; }
        const onsets = (tone: number) => {
          const step = Math.round(rate * 0.0005), window = Math.round(rate * 0.002);
          const envelope: number[] = [];
          for (let start = 0; start + window < pcm.length; start += step) {
            let re = 0, im = 0;
            for (let i = start; i < start + window; i++) {
              const phase = 2 * Math.PI * tone * i / rate;
              re += pcm[i] * Math.cos(phase); im -= pcm[i] * Math.sin(phase);
            }
            envelope.push(Math.hypot(re, im) / window);
          }
          const peak = Math.max(...envelope);
          const times: number[] = [];
          let quietUntil = 0;
          envelope.forEach((value, index) => {
            const time = (index * step + window / 2) / rate;
            if (value > peak * 0.08 && time >= quietUntil) { times.push(time); quietUntil = time + 0.15; }
          });
          return times;
        };
        const mix = JSON.parse(diagnostics.playbackDiagnosticExport()).events
          .filter((row: { event: string }) => row.event.startsWith('mix.')).map((row: { event: string }) => row.event);
        button.dataset.result = JSON.stringify({ out: onsets(outTone), in: onsets(inTone), speeds, mix,
          finalIn });
      } catch (error) {
        const diagnosticsPath = '/player/src/lib/playbackDiagnostics.ts';
        const diagnostics = await import(diagnosticsPath);
        const mix = JSON.parse(diagnostics.playbackDiagnosticExport()).events
          .filter((row: { event: string }) => row.event.startsWith('mix.')).map((row: { event: string; facts: Record<string, unknown> }) => [row.event, row.facts.reason]);
        const audioPath = '/player/src/lib/audio.ts';
        const decks = (await import(audioPath)).audioService.programMixSnapshot();
        button.dataset.result = JSON.stringify({ error: String(error), mix, decks, log: (window as unknown as { __log?: string[] }).__log?.slice(-30) });
      }
    };
    document.body.append(button);
  }, { plan, outTone: OUT_TONE, inTone: IN_TONE });
  const button = page.getByRole('button', { name: 'Probar tempo compartido', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('data-result', /./, { timeout: 60_000 });
  const result = JSON.parse((await button.getAttribute('data-result'))!);
  expect(result.error, JSON.stringify({ mix: result.mix, decks: result.decks, log: result.log }, null, 1)).toBeUndefined();
  const out: number[] = result.out, incoming: number[] = result.in;
  // No fallback: the blend ran as planned.
  expect(result.mix).toEqual(['mix.started']);
  const speeds: Array<[number, number]> = result.speeds;

  // The outgoing deck kept its speed until the ramp, reached the shared one
  // over it, and held it through the blend.
  const rampStart = plan.out_cue - ramp.lead_seconds;
  expect(speeds.filter(([at]) => at < rampStart - 0.1).every(([, speed]) => speed === 1)).toBe(true);
  expect(speeds.filter(([at]) => at > rampStart + ramp.seconds + 0.1).every(([, speed]) => speed === outRate)).toBe(true);
  // Heard tempo: outgoing beats before the ramp, both decks during the blend.
  const intervals = (times: number[]) => times.slice(1).map((time, index) => time - times[index]);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  expect(median(intervals(out.slice(2, 8)))).toBeCloseTo(outBeat, 2);
  const shared = outBeat / outRate;
  // Only kicks where both decks sound: the incoming deck goes on alone after
  // the blend, and the faded outgoing one drops below the detector first.
  const both = incoming.filter(time => time <= out[out.length - 1] + shared / 2);
  const blend = both.slice(Math.floor(both.length * 0.2), Math.ceil(both.length * 0.8));
  expect(blend.length).toBeGreaterThanOrEqual(5);
  // Seconds per kick from a line through the blend's kicks: phase riding
  // moves the incoming deck by up to 2 % and the renderer's stretching moves
  // single kicks, so a median of a few intervals wanders by about 1 %. The
  // speeds that would fail differ by more than 4.7 % (0.500 or 0.4545 s).
  const beatOf = (times: number[]) => {
    const mean = times.reduce((sum, time) => sum + time, 0) / times.length, middle = (times.length - 1) / 2;
    return times.reduce((sum, time, index) => sum + (index - middle) * (time - mean), 0)
      / times.reduce((sum, _, index) => sum + (index - middle) ** 2, 0);
  };
  expect(Math.abs(beatOf(blend) / shared - 1)).toBeLessThan(0.015);
  // Every incoming kick in the blend lands on an outgoing one.
  const signed = blend.map(time => { const beat = out.reduce((best, candidate) => Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best); return time - beat; });
  // A renderer that time-stretches moves single kicks of a deck by several
  // milliseconds on its own (Chromium, outgoing deck alone at 1.0476: −17 to
  // +15 ms between consecutive kicks), so single kicks cannot be held to the
  // planner's 5 ms. Their mean can: an unaccounted speed would drift by
  // 4.8 % of the blend, 270 ms. Measured in Chromium, before (one deck, main)
  // and after: a mean absolute error of 8–18 ms across the blend.
  const meanAbs = signed.reduce((sum, value) => sum + Math.abs(value), 0) / signed.length;
  console.log(`${browserName} ${name}: beat ${shared.toFixed(4)} s, mean |error| ${(meanAbs * 1000).toFixed(1)} ms, signed (ms) ${signed.map(e => (e * 1000).toFixed(1)).join(' ')}`);
  expect(meanAbs).toBeLessThan(0.03);
  // The blend hands over at the incoming deck's mix speed; it then returns
  // to its own tempo gradually instead of jumping.
  expect(result.finalIn).toBeLessThan(1);
});
