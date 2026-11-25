import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { settle } from '../tests/browser/settle';
import { mockShowcaseEngine, NOW_PLAYING, SHOWCASE_PALETTES } from './engine';
import { stillFrame, writePicture } from './picture';

/**
 * Every screenshot, in every theme. Written to
 * `docs/images/screenshots/<theme>/<name>.webp`, where the README and the site
 * pick them up. The landing includes examples of custom colors.
 */

const SCREENSHOTS = join(import.meta.dirname, '..', '..', 'docs', 'images', 'screenshots');

async function startup(page: Page, route: string) {
  await page.goto(`/player/#${route}`);
  await expect(page.locator('#startup-screen')).toHaveCount(0);
  const omni = page.locator('[data-omni-player]');
  await expect(omni).toContainText(NOW_PLAYING.title);
  await omni.getByRole('button', { name: 'Play' }).click();
  await expect(omni.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.mouse.move(0, 0);
}

async function openPlayer(page: Page) {
  await startup(page, '/library?view=songs');
  await page.locator('[data-omni-player]').getByRole('button', { name: /^NORMAL:/ }).click();
  await expect(page.locator('[data-player-surface-open]')).toBeVisible();
  await page.mouse.move(0, 0);
  await settle(page, '[data-player-surface-open]');
}

const SHOTS: Array<{ name: string; project: 'desktop' | 'mobile'; themes?: string[]; stage: (page: Page) => Promise<void> }> = [
  { name: 'desktop-now-playing', project: 'desktop', stage: openPlayer },
  {
    name: 'desktop-lyrics',
    project: 'desktop',
    themes: ['dark'], // The social card uses the dark shell with its lyrics open.
    stage: async (page) => {
      await openPlayer(page);
      await page.locator('[data-compact-lyrics-toggle]').click();
      await expect(page.locator('[data-compact-lyrics]')).toBeInViewport({ ratio: 1 });
      await expect(page.locator('[data-compact-lyrics]')).toContainText('And god help any fool');
      await page.mouse.move(0, 0);
      await settle(page, '[data-player-surface-open]');
    },
  },
  { name: 'desktop-library', project: 'desktop', stage: (page) => startup(page, '/library?view=songs') },
  { name: 'desktop-search', project: 'desktop', stage: (page) => startup(page, '/search?q=Josh%20Woodward') },
  { name: 'mobile-library', project: 'mobile', stage: (page) => startup(page, '/library?view=songs') },
  {
    name: 'mobile-now-playing',
    project: 'mobile',
    stage: async (page) => {
      await openPlayer(page);
      await page.locator('[data-compact-lyrics-toggle]').click();
      await expect(page.locator('[data-compact-lyrics]')).toBeInViewport({ ratio: 1 });
      await settle(page, '[data-player-surface-open]');
    },
  },
];

for (const shot of SHOTS) {
  for (const theme of shot.themes ?? SHOWCASE_PALETTES) {
    test(`${shot.name} · ${theme}`, async ({ page }, info) => {
      test.skip(info.project.name !== shot.project, `${shot.name} is a ${shot.project} screenshot`);
      await mockShowcaseEngine(page, theme);
      await shot.stage(page);
      await writePicture(page, await stillFrame(page), join(SCREENSHOTS, theme, `${shot.name}.webp`));
    });
  }
}
