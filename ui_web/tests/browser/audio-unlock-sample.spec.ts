import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('the gesture unlock sample decodes and actually plays on the browser renderer', async ({ page }) => {
  await mockMusicEngine(page);
  await page.goto('/player/');
  const result = await page.evaluate(async () => {
    const path = '/player/src/lib/audio/unlockSample.ts';
    const { SILENT_WAV } = await import(path);
    const context = new AudioContext();
    try {
      const bytes = await (await fetch(SILENT_WAV)).arrayBuffer();
      const decoded = await context.decodeAudioData(bytes);
      const button = document.createElement('button');
      button.textContent = 'Probar desbloqueo';
      button.onclick = () => {
        const audio = new Audio(SILENT_WAV);
        audio.muted = true;
        void audio.play().then(() => {
          button.dataset.result = 'playing';
          audio.pause();
        }, () => { button.dataset.result = 'failed'; });
      };
      document.body.append(button);
      return { duration: decoded.duration, silent: decoded.getChannelData(0).every(value => value === 0) };
    } finally { await context.close(); }
  });
  expect(result.duration).toBeCloseTo(0.02, 6);
  expect(result.silent).toBe(true);
  const button = page.getByRole('button', { name: 'Probar desbloqueo' });
  await button.click();
  await expect(button).toHaveAttribute('data-result', 'playing');
});
