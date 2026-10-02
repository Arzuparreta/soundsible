import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * A frame worth keeping: every image decoded, every font loaded, and three
 * screenshots in a row identical, so nothing caught mid-transition.
 */
export async function stillFrame(page: Page): Promise<Buffer> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((image) => image.decode().catch(() => undefined))]));
  // A paused infinite animation keeps the frame it had reached — the queue's
  // equalizer while a song is paused — and `animations: 'disabled'` leaves it
  // there, so the picture depended on how fast the machine got to it. Every
  // one of them starts from its first frame instead.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (!Number.isFinite(animation.effect?.getTiming().iterations ?? 1)) animation.currentTime = 0;
    }
  });
  const frames: Buffer[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    frames.push(await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' }));
    const [a, b, c] = frames.slice(-3);
    if (c && a.equals(b) && b.equals(c)) return c;
    await page.waitForTimeout(400);
  }
  throw new Error('The page never held still long enough to photograph.');
}

/**
 * Pixels allowed to differ before a picture counts as changed. Chromium
 * sometimes rasterises a downscaled cover with a different filter depending on
 * load, which moves a few dozen pixels by a few levels. A real change to the
 * interface moves thousands.
 */
const NOISE = { level: 12, share: 0.0002 };

/**
 * Write a screenshot to `path`, as WebP when the name says so, encoded in the
 * browser that took it so there is no image tooling to install.
 *
 * The file is only rewritten when the picture has actually changed: a refresh
 * that changed nothing leaves git with nothing to commit, rather than 25 files
 * of rendering noise.
 */
export async function writePicture(page: Page, png: Buffer, path: string): Promise<void> {
  const webp = path.endsWith('.webp');
  const blank = await page.context().newPage();
  const encoded = await blank.evaluate(async ({ source, previous, webp, noise }) => {
    const pixels = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return { canvas, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const current = await pixels(`data:image/png;base64,${source}`);
    const output = webp ? current.canvas.toDataURL('image/webp', 0.9) : null;
    if (previous) {
      const before = await pixels(`data:image/${webp ? 'webp' : 'png'};base64,${previous}`);
      const after = output ? await pixels(output) : current;
      if (before.data.length === after.data.length) {
        let changed = 0;
        for (let i = 0; i < after.data.length; i += 4) {
          if (Math.max(
            Math.abs(after.data[i] - before.data[i]),
            Math.abs(after.data[i + 1] - before.data[i + 1]),
            Math.abs(after.data[i + 2] - before.data[i + 2]),
          ) > noise.level) changed++;
        }
        if (changed <= (after.data.length / 4) * noise.share) return { keep: true, output: null };
      }
    }
    return { keep: false, output: output?.split(',')[1] ?? null };
  }, {
    source: png.toString('base64'),
    previous: existsSync(path) ? readFileSync(path).toString('base64') : null,
    webp,
    noise: NOISE,
  });
  await blank.close();
  if (encoded.keep) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encoded.output ? Buffer.from(encoded.output, 'base64') : png);
}
