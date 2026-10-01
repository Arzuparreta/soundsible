// Run fixture servers first; no request interception (it would disable HTTP caching).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const [before, after, output] = process.argv.slice(2);
const constrained = process.argv.includes('--constrained');
if (!before || !after || !output) throw new Error('Usage: node scripts/measure-payload.mjs BEFORE_URL AFTER_URL OUTPUT_JSON');
const browser = await chromium.launch();
const results = [];
try {
  for (const [revision, origin] of [['before', before], ['after', after]]) {
    for (const screen of ['login', 'library']) {
      for (let repeat = 0; repeat < (constrained ? 3 : 5); repeat++) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        await context.addCookies([{ name: 'payload_auth', value: screen === 'library' ? '1' : '0', url: origin }]);
        await context.addInitScript(() => localStorage.setItem('lang', 'es'));
        const page = await context.newPage();
        if (constrained) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750 });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        for (const cache of ['cold', 'warm']) {
          if (cache === 'cold') await page.goto(origin + '/player/');
          else await page.reload();
          await (screen === 'login' ? page.locator('#login-username') : page.locator('nav:visible').first()).waitFor();
          const ready_ms = await page.evaluate(() => performance.now());
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(500);
          const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ url: e.name.replace(location.origin, ''), initiator: e.initiatorType, transfer_bytes: e.transferSize, encoded_bytes: e.encodedBodySize, decoded_bytes: e.decodedBodySize, duration_ms: e.duration })));
          const groups = {};
          for (const resource of resources) {
            const group = /\/api\//.test(resource.url) ? 'api' : /socket.io/.test(resource.url) ? 'socket' : /\.js(?:\?|$)/.test(resource.url) ? 'js' : /\.css(?:\?|$)/.test(resource.url) ? 'css' : /\.woff2?(?:\?|$)/.test(resource.url) ? 'font' : 'other';
            groups[group] ??= { requests: 0, transfer_bytes: 0, encoded_bytes: 0, decoded_bytes: 0 };
            groups[group].requests++;
            for (const key of ['transfer_bytes', 'encoded_bytes', 'decoded_bytes']) groups[group][key] += resource[key];
          }
          const build_id = await page.evaluate(() => document.querySelector('meta[name="soundsible-build"]')?.getAttribute('content') ?? null);
          results.push({ revision, build_id, screen, repeat, cache, ready_ms, groups, resources });
        }
        await context.close();
      }
    }
  }
} finally { await browser.close(); }
writeFileSync(output, JSON.stringify({ network: constrained ? { latency_ms: 150, download_bytes_per_second: 200000, upload_bytes_per_second: 93750, cpu_slowdown: 4, repeats: 3 } : { throttling: 'none', repeats: 5 }, method: 'Chromium, 390x844, Spanish, isolated empty-library HTTP fixture, fresh contexts per screen, then same-context reload. Service worker blocked to separate HTTP cache; no interception ; network conditions recorded separately. Resource Timing transferSize includes response overhead; zero indicates HTTP cache. ready_ms is local lab navigation-to-visible-UI, not device or Internet latency.', results }, null, 2) + '\n');
