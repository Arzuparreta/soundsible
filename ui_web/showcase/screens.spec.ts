import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { THEMES } from '../src/boot/themes';
import { settle } from '../tests/browser/settle';
import { mockShowcaseEngine, NOW_PLAYING } from './engine';
import { stillFrame, writePicture } from './picture';

/**
 * Every screenshot, in every theme. Written to
 * `docs/images/screenshots/<theme>/<name>.webp`, where the README and the site
 * pick them up; a theme added to `THEMES` is photographed without touching
 * this file.
 */

const SCREENSHOTS = join(import.meta.dirname, '..', '..', 'docs', 'images', 'screenshots');
const PALETTES = THEMES.filter((theme) => theme !== 'system');

async function startup(page: Page, route: string) {
  await page.goto(`/player/#${route}`);
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  await expect(page.locator('[data-omni-player]')).toContainText(NOW_PLAYING.title);
}

async function openPlayer(page: Page) {
  await startup(page, '/library?view=songs');
  await page.locator('[data-omni-player]').getByRole('button', { name: /^NORMAL:/ }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  await settle(page, '[data-player-surface-open]');
}

const SHOTS: Array<{ name: string; project: 'desktop' | 'mobile'; stage: (page: Page) => Promise<void> }> = [
  { name: 'desktop-now-playing', project: 'desktop', stage: openPlayer },
  { name: 'desktop-library', project: 'desktop', stage: (page) => startup(page, '/library?view=songs') },
  { name: 'desktop-search', project: 'desktop', stage: (page) => startup(page, '/search?q=Josh%20Woodward') },
  { name: 'mobile-library', project: 'mobile', stage: (page) => startup(page, '/library?view=songs') },
  {
    name: 'mobile-now-playing',
    project: 'mobile',
    stage: async (page) => {
      await openPlayer(page);
      await page.locator('[data-player-stage-mode="now-playing"]').getByRole('button', { name: 'Show lyrics' }).click();
      // In the viewport, not merely rendered: the phone's player is a carousel,
      // and a busy machine has landed it on the queue page with the lyrics
      // open one page over.
      await expect(page.locator('[data-lyrics-open]')).toBeInViewport({ ratio: 1 });
      await settle(page, '[data-player-surface-open]');
    },
  },
];

for (const shot of SHOTS) {
  for (const theme of PALETTES) {
    test(`${shot.name} · ${theme}`, async ({ page }, info) => {
      test.skip(info.project.name !== shot.project, `${shot.name} is a ${shot.project} screenshot`);
      await mockShowcaseEngine(page, theme);
      await shot.stage(page);
      await writePicture(page, await stillFrame(page), join(SCREENSHOTS, theme, `${shot.name}.webp`));
    });
  }
}
