// Serve the built directory over HTTP and pass its URL, including the trailing slash.
import { createRequire } from 'node:module';
const { chromium, webkit } = createRequire(new URL('../../ui_web/package.json', import.meta.url))('playwright');
const mobile = process.argv[3] === 'webkit';
const browser = await (mobile ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.demoAudio = this;
      return play.call(this);
    };
  });
  await page.goto(process.argv[2]);
  await page.getByRole('button', { name: 'Play Glass Steps by Soundsible' }).click();
  await page.waitForFunction(() => window.demoAudio?.currentTime > 0.5);
  await page.evaluate(() => { window.demoAudio.currentTime = window.demoAudio.duration - 2; });
  await page.waitForFunction(() => window.demoAudio.currentTime > 13);
  await page.waitForFunction(() => window.demoAudio.currentSrc.endsWith('/late-platform.wav') && window.demoAudio.currentTime > 0.2);
  console.log('Playback, seek and automatic track advance passed.');
} finally {
  await browser.close();
}
