#!/usr/bin/env node
/** Compose the existing showcase captures without starting the app or engine. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const require = createRequire(new URL('ui_web/package.json', root));
const { chromium } = require('playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
  await mkdir(new URL('docs/images/', root), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(new URL('docs/internal/showcase/readme.html', root).href);
    await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
    const sources = await page.locator('img').evaluateAll(images => images.map(image => image.currentSrc));
    assert(sources.every(source => source.includes(`/screenshots/${theme}/`)), `Incorrect ${theme} capture sources`);
    const output = fileURLToPath(new URL(`docs/images/readme-${theme}.png`, root));
    await page.screenshot({ path: output, omitBackground: true, animations: 'disabled' });
    console.log(output);
  }
} finally {
  await browser.close();
}
