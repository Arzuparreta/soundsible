import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('measures real PCM before and after the fader independently', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/');
  await page.evaluate(async () => {
    const path = '/player/src/lib/audio/signal.ts';
    const { createSignalMeter } = await import(path);
    const button = document.createElement('button');
    button.textContent = 'Probar señal';
    button.onclick = async () => {
      const context = new AudioContext();
      try {
        await context.resume();
        const source = context.createOscillator();
        source.frequency.value = 440;
        const inverse = context.createGain(); inverse.gain.value = -1;
        const stereo = context.createChannelMerger(2);
        source.connect(stereo, 0, 0);
        source.connect(inverse).connect(stereo, 0, 1);
        const input = createSignalMeter(context)!, output = createSignalMeter(context)!;
        const gain = context.createGain(); gain.gain.value = 0;
        stereo.connect(input.node).connect(gain).connect(output.node).connect(context.destination);
        source.start();
        const sample = async () => {
          await new Promise(resolve => setTimeout(resolve, 150));
          return { input: input.read(), output: output.read() };
        };
        const muted = await sample();
        gain.gain.value = 0.5;
        const sounding = await sample();
        source.stop();
        button.dataset.result = JSON.stringify({ muted, sounding });
      } finally { await context.close(); }
    };
    document.body.append(button);
  });
  const button = page.getByRole('button', { name: 'Probar señal', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('data-result', /sounding/);
  const { muted, sounding } = JSON.parse((await button.getAttribute('data-result'))!);
  expect(muted.input).toBeGreaterThan(0.5);
  expect(muted.output).toBe(0);
  expect(sounding.output).toBeGreaterThan(0.25);
  expect(sounding.output).toBeLessThan(0.5);
});
