// Accepts a direct demo URL or the landing page URL when testing the iframe.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium, webkit } = createRequire(new URL('../../ui_web/package.json', import.meta.url))('playwright');
const mobile = process.argv.includes('webkit');
const embedded = process.argv.includes('--embedded');
const browser = await (mobile ? webkit : chromium).launch();
try {
  const page = await browser.newPage({
    serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile,
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  const audioRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('.mp3')) audioRequests.push(request.url()); });
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.demoAudio = this;
      return play.call(this);
    };
  });
  await page.goto(process.argv[2]);
  if (embedded) {
    assert.equal(await page.locator('iframe[data-demo-src]').getAttribute('src'), null);
    await page.getByRole('button', { name: 'Try Soundsible' }).click();
  }
  const player = embedded ? page.frameLocator('iframe[data-demo-src]') : page;
  await player.getByRole('link', { name: 'Ashes', exact: true }).click();
  assert.equal(audioRequests.length, 0, 'browsing the demo downloads no audio');
  await player.getByRole('button', { name: 'Play Let It In by Josh Woodward' }).click();
  const frame = page.frames().find(candidate => candidate.url().includes('player.html'));
  await frame.waitForFunction(() => window.demoAudio?.currentTime > 0.5);
  if (mobile) {
    await player.locator('[data-music-list-row]').filter({ hasText: 'Cherubs' }).locator('[data-row-menu]').tap();
    await player.getByText('Add to favourites', { exact: true }).tap();
  } else {
    const row = player.locator('[data-song-row]').filter({ hasText: 'Cherubs' });
    await row.getByRole('button', { name: 'Add to favourites' }).click();
    await row.getByRole('button', { name: 'Remove from favourites' }).waitFor();
  }

  let next = 'cherubs';
  if (!mobile) {
    await player.getByRole('link', { name: 'Search', exact: true }).click();
    const search = player.getByPlaceholder('Search the demo library');
    await search.fill('Pompeii');
    await search.press('Enter');
    await player.getByText('Pompeii', { exact: true }).first().waitFor();
    await player.getByRole('link', { name: 'Songs', exact: true }).click();
    await player.locator('[data-song-row]').filter({ hasText: 'Pompeii' })
      .getByRole('button', { name: 'More options' }).click();
    await player.getByText('Play next', { exact: true }).click();
    next = 'pompeii';
  }

  // The native keyboard interaction exercises the real seek input and sends
  // playback near the end without modifying the media element under test.
  const seek = player.locator('[data-omni-seek]').getByRole('slider', { name: 'Seek' });
  await seek.press('End');
  await frame.waitForFunction(track =>
    window.demoAudio?.currentSrc.includes(`/media/${track}-`) && window.demoAudio.currentTime > 0.2, next);

  // Reopen the demo to verify the mark was written, beyond the optimistic UI.
  await frame.goto(new URL('player.html#/favourites', frame.url()).href);
  await player.getByText('Cherubs', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  if (embedded) {
    await page.getByRole('button', { name: 'Close player' }).click();
    assert.equal(await page.locator('iframe[data-demo-src]').getAttribute('src'), null);
  }
  console.log('Album browsing, real playback, seek, automatic advance and persistent favourites passed. Desktop also checks search and Play next.');
} finally {
  await browser.close();
}
