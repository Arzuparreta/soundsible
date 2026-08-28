import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const audioBytes = Buffer.from(
  readFileSync(new URL('./fixtures/progressive-preview.mp3.b64', import.meta.url), 'utf8'),
  'base64',
);

test('a media element accepts a proven growing-spool response before it completes', async ({ page }) => {
  // Six seconds of encoded audio: the backend uses the same
  // minimum media-time budget before it publishes `streamable`.
  const prefixBytes = Math.ceil(audioBytes.length / 8 * 6);
  let releaseRemainder!: () => void;
  const remainderGate = new Promise<void>((resolve) => { releaseRemainder = resolve; });
  let responseCompleted = false;
  let requestCount = 0;
  const server: Server = createServer(async (request, response) => {
    requestCount += 1;
    const rawRange = request.headers.range ?? '';
    const match = /^bytes=(\d+)-(\d*)$/.exec(rawRange);
    const start = match ? Number(match[1]) : 0;
    const requestedEnd = match?.[2] ? Number(match[2]) : audioBytes.length - 1;
    const end = Math.min(audioBytes.length - 1, requestedEnd);
    const body = audioBytes.subarray(start, end + 1);
    response.statusCode = match ? 206 : 200;
    response.setHeader('Content-Type', 'audio/mpeg');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', body.length);
    if (match) response.setHeader('Content-Range', `bytes ${start}-${end}/${audioBytes.length}`);

    // Tiny decoder probes and non-zero future ranges are answered normally.
    // The main zero-based response is the deliberately growing local spool.
    if (start !== 0 || end < prefixBytes) {
      response.end(body);
      return;
    }
    const localPrefixEnd = Math.min(body.length, prefixBytes);
    response.write(body.subarray(0, localPrefixEnd));
    await remainderGate;
    response.end(body.subarray(localPrefixEnd));
    responseCompleted = true;
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    // Keep a loopback HTTP origin. Chromium blocks private-network media from
    // an opaque about:blank origin before it ever reaches the test server.
    await page.goto('/player/');
    await page.setContent('<audio id="preview" preload="auto"></audio>');
    await page.locator('#preview').evaluate((element, source) => new Promise<void>((resolve, reject) => {
      const audio = element as HTMLAudioElement;
      const timer = window.setTimeout(() => reject(new Error(
        `media did not advance (readyState ${audio.readyState}, currentTime ${audio.currentTime})`,
      )), 10_000);
      audio.addEventListener('timeupdate', () => {
        if (audio.currentTime < 0.25) return;
        window.clearTimeout(timer);
        resolve();
      });
      audio.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error(`media error ${audio.error?.code ?? 'unknown'}`));
      }, { once: true });
      audio.src = source;
      audio.load();
      void audio.play().catch((error) => reject(error));
    }), `http://127.0.0.1:${address.port}/preview.mp3`);

    expect(responseCompleted).toBe(false);
    expect(requestCount).toBeGreaterThan(0);
    const currentTime = await page.locator('#preview').evaluate((element) => (element as HTMLAudioElement).currentTime);
    expect(currentTime).toBeGreaterThanOrEqual(0.25);
  } finally {
    releaseRemainder();
    await page.locator('#preview').evaluate((element) => {
      const audio = element as HTMLAudioElement;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
