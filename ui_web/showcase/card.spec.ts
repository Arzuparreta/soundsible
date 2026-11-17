import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { writePicture } from './picture';

/** GitHub refuses a social preview over 1 MB. */
const LIMIT = 1_000_000;
const CARD = join(import.meta.dirname, '..', '..', 'docs', 'images', 'social-card.png');

test('social card', async ({ page }) => {
  await page.goto(pathToFileURL(join(import.meta.dirname, 'card.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  // Feeds can center-crop the 2:1 upload to an approximately 8:3 banner.
  // Keep the branding and both complete devices inside that crop, with side margins.
  for (const element of await page.locator('.copy, .desktop, .phone').all()) {
    const bounds = (await element.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(80);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1200);
    expect(bounds.y).toBeGreaterThanOrEqual(80);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
  }
  await writePicture(page, await page.screenshot({ animations: 'disabled' }), CARD);
  expect(statSync(CARD).size, 'GitHub takes a social preview of at most 1 MB').toBeLessThan(LIMIT);
});
