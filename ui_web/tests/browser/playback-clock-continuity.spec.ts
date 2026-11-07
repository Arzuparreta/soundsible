import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('a finite source-clock delay does not interrupt real programme PCM', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/');
  await page.evaluate(async () => {
    const audioPath = '/player/src/lib/audio.ts';
    const { audioService, audioEl, onProgramEvent } = await import(audioPath);
    const button = document.createElement('button');
    button.textContent = 'Probar continuidad';
    button.onclick = async () => {
      audioService.unlockAudio();
      const deck = audioEl() as HTMLAudioElement;
      const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
      let epoch: number | null = null, origin = 0;
      const activated = () => { epoch = performance.now(); };
      deck.addEventListener('playing', activated);
      // Fault injection affects the reported clock only. The WAV decoder and
      // programme graph still render real audio, independently measured below.
      Object.defineProperty(deck, 'currentTime', { configurable: true,
        get: () => epoch === null ? native.get!.call(deck) : origin + Math.max(0, (performance.now() - epoch - 650) / 1000),
        set: (value: number) => { origin = value; epoch = null; native.set!.call(deck, value); },
      });
      const healthEvents: string[] = [];
      const unsubscribe = onProgramEvent('outputhealth', () => healthEvents.push(audioService.outputHealth()));
      const recorder = new AudioContext();
      const blocks: Float32Array[] = [];
      try {
        await recorder.resume();
        const capture = audioService.acquireBroadcastCapture();
        if (!capture) throw new Error('no programme capture');
        const source = recorder.createMediaStreamSource(capture.stream);
        const tap = recorder.createScriptProcessor(1024, 1, 1);
        const silent = recorder.createGain(); silent.gain.value = 0;
        tap.onaudioprocess = event => blocks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        source.connect(tap).connect(silent).connect(recorder.destination);
        await audioService.load('/api/static/stream/clock-continuity', 1);
        // Cover both confirmation windows and the former recovery/restart loop.
        await new Promise(resolve => setTimeout(resolve, 4500));
        const snapshot = audioService.snapshot();
        source.disconnect(); tap.disconnect();
        await recorder.close();
        const pcm = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
        let offset = 0;
        for (const block of blocks) { pcm.set(block, offset); offset += block.length; }
        const step = Math.round(recorder.sampleRate * 0.01); // 10 ms RMS windows
        let first = -1, last = -1, gap = 0, longestGap = 0;
        for (let i = 0; i + step <= pcm.length; i += step) {
          let power = 0;
          for (let j = i; j < i + step; j++) power += pcm[j] * pcm[j];
          if (Math.sqrt(power / step) > 0.0001) {
            if (first < 0) first = i;
            last = i + step;
            longestGap = Math.max(longestGap, gap); gap = 0;
          } else if (first >= 0) gap += step;
        }
        button.dataset.result = JSON.stringify({ healthEvents, playing: snapshot.playing,
          position: snapshot.position, signalMs: (last - first) / recorder.sampleRate * 1000,
          longestGapMs: longestGap / recorder.sampleRate * 1000 });
      } catch (error) {
        button.dataset.result = JSON.stringify({ error: String(error) });
      } finally {
        unsubscribe();
        deck.removeEventListener('playing', activated);
        Reflect.deleteProperty(deck, 'currentTime');
        if (recorder.state !== 'closed') await recorder.close();
        audioService.stop();
        audioService.releaseBroadcastStream();
      }
    };
    document.body.append(button);
  });
  const button = page.getByRole('button', { name: 'Probar continuidad', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('data-result', /./, { timeout: 12_000 });
  const result = JSON.parse((await button.getAttribute('data-result'))!);
  expect(result.error).toBeUndefined();
  expect(result.healthEvents).toEqual([]);
  expect(result.playing).toBe(true);
  expect(result.position).toBeGreaterThan(3);
  expect(result.signalMs).toBeGreaterThan(3500);
  expect(result.longestGapMs).toBeLessThan(20);
});
