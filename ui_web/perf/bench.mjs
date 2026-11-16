#!/usr/bin/env node
/**
 * Rendering bench for the web UI: scrolls each collection surface of a
 * production bundle with real wheel input and reports frames presented,
 * partial and dropped, the gap between displayed frames, and main-thread work.
 *
 *   node perf/bench.mjs                      every surface, paused, 1× and 6× CPU
 *   SURFACES=songs,favourites RATES=6 node perf/bench.mjs
 *   PLAYING=1 node perf/bench.mjs            with a track playing
 *   node perf/bench.mjs --table a.json [b.json]   print or compare saved results
 *
 * See perf/README.md for what the numbers mean and how to compare two runs.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture, SIZES, startServer } from './fixture.mjs';
import { analyse, median } from './trace.mjs';

const root = resolve(import.meta.dirname, '..');

/** Where each surface lives and which element proves it has rendered. */
const SURFACES = {
  songs: { hash: '#/library?view=songs', ready: '[data-song-row], [data-music-list-row]' },
  favourites: { hash: '#/favourites', ready: '[data-song-row], [data-music-list-row]' },
  albums: { hash: '#/library?view=albums', ready: 'a[href*="/album/"]' },
  artists: { hash: '#/library?view=artists', ready: 'a[href*="/artist/"]' },
  album: { hash: `#/album/${encodeURIComponent(fixture.albums[0].title)}?artist=${encodeURIComponent(fixture.albums[0].artist.name)}&view=library&album_id=${fixture.albums[0].id}`, ready: '[data-song-row], [data-music-list-row]' },
  artist: { hash: `#/artist/${encodeURIComponent(fixture.artists[0].name)}?view=library&artist_id=${fixture.artists[0].id}`, ready: '[data-song-row], [data-music-list-row]' },
  playlist: { hash: '#/playlists/Playlist%201', ready: '[data-song-row], [data-music-list-row]' },
};

/** The input: one wheel event per 60 Hz frame for 3.2 s, 7,500 px/s. */
const BURST_MS = 3200, WHEEL_INTERVAL_MS = 16, WHEEL_DELTA = 120;
const CATEGORIES = ['benchmark', 'cc', 'toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', '__metadata'];

const list = (name, fallback) => (process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function table(rows, baseline) {
  const key = (row) => `${row.surface}|${row.playing}|${row.cpu_rate}`;
  const before = new Map((baseline ?? []).map((row) => [key(row), row]));
  const cell = (row) => `${row.frames.presented - row.frames.partial}/${row.frames.expected} | ${row.frames.partial}/${row.frames.dropped} | ${row.display_gap_ms.p50} / ${row.display_gap_ms.p95} / ${row.display_gap_ms.max} | ${row.main_thread_ms.longest_task} | ${row.main_thread_ms.script} / ${row.main_thread_ms.layout} / ${row.main_thread_ms.paint}`;
  const lines = ['| Surface | CPU | Complete / expected | Partial / dropped | Display gap p50 / p95 / max, ms | Longest task, ms | Script / layout / paint, ms |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const row of rows) {
    const label = `${row.surface}${row.playing ? ', playing' : ''}`;
    const old = before.get(key(row));
    if (old) lines.push(`| ${label} (before) | ${row.cpu_rate}× | ${cell(old)} |`);
    lines.push(`| ${label}${old ? ' (after)' : ''} | ${row.cpu_rate}× | ${cell(row)} |`);
  }
  return lines.join('\n');
}

if (process.argv[2] === '--table') {
  const [after, before] = [process.argv[4] ?? process.argv[3], process.argv[4] ? process.argv[3] : undefined].map((file) => file && JSON.parse(readFileSync(file, 'utf8')));
  console.log(table(after.results, before?.results));
  process.exit(0);
}

const surfaces = list('SURFACES', Object.keys(SURFACES).join(','));
const rates = list('RATES', '1,6').map(Number);
const playing = process.env.PLAYING === '1';
const repeats = Number(process.env.REPEATS ?? 3);
const [width, height] = (process.env.SIZE ?? '1366x768').split('x').map(Number);
const tag = process.env.TAG ?? 'run';
for (const name of surfaces) if (!SURFACES[name]) throw new Error(`Unknown surface ${name}; known: ${Object.keys(SURFACES).join(', ')}`);

// A production bundle, built outside the tree: `ui_web/dist` belongs to the
// running engine and must not be touched from here.
const work = mkdtempSync(join(tmpdir(), 'soundsible-bench-'));
const dist = process.env.DIST ?? join(work, 'dist');
if (!process.env.DIST) {
  console.error('Building the production bundle…');
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
}
const server = await startServer(dist);

// New headless (`channel: 'chromium'`) can use the machine's GPU; the default
// headless shell cannot. SOFTWARE=1 forces SwiftShader for the no-GPU case.
const software = process.env.SOFTWARE === '1';
const browser = await chromium.launch({
  channel: 'chromium',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    ...(software ? ['--use-angle=swiftshader', '--disable-gpu-rasterization'] : ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']),
  ],
});

async function open() {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'dark' });
  await context.addInitScript(() => {
    localStorage.setItem('lang', 'en');
    localStorage.setItem('soundsible:interface-size', 'normal');
    localStorage.setItem('device_id', 'bench-device');
  });
  const page = await context.newPage();
  return { context, page };
}

async function measure(name, rate) {
  const surface = SURFACES[name];
  const { context, page } = await open();
  try {
    await page.goto(`${server.origin}/player/#/library?view=songs`);
    await page.locator(SURFACES.songs.ready).first().waitFor({ timeout: 30_000 });
    if (playing) {
      await page.getByRole('button', { name: /^Play .+ by / }).first().click();
      await page.waitForFunction(() => navigator.mediaSession?.playbackState === 'playing', undefined, { timeout: 15_000 });
    }
    if (name !== 'songs') {
      await page.evaluate((hash) => { window.location.hash = hash; }, surface.hash);
      await page.locator(surface.ready).first().waitFor({ timeout: 30_000 });
    }
    // Images, fonts and the first idle callbacks; the burst measures scrolling,
    // not the page still arriving.
    // Not `networkidle`: a playing session keeps reporting its position.
    await page.waitForFunction(() => [...document.images].every((image) => image.complete), undefined, { timeout: 15_000 }).catch(() => {});
    await sleep(1500);

    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate });
    const x = Math.round(width * 0.6), y = Math.round(height * 0.5);
    await page.mouse.move(x, y);
    const scrollBefore = await page.evaluate(() => [...document.querySelectorAll('*')].reduce((sum, element) => sum + element.scrollTop, 0));

    await browser.startTracing(page, { categories: CATEGORIES });
    const started = await page.evaluate(() => performance.now());
    const sends = [];
    const began = Date.now();
    for (let tick = 0; tick * WHEEL_INTERVAL_MS < BURST_MS; tick += 1) {
      const due = began + tick * WHEEL_INTERVAL_MS;
      if (due > Date.now()) await sleep(due - Date.now());
      sends.push(session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: WHEEL_DELTA }).catch(() => {}));
    }
    // The tail: frames the burst caused that are still being produced.
    await sleep(400);
    const ended = await page.evaluate(() => performance.now());
    const trace = JSON.parse((await browser.stopTracing()).toString());
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await Promise.race([Promise.all(sends), sleep(5000)]);

    const events = trace.traceEvents ?? trace;
    // KEEP_TRACE=<dir> keeps the raw trace for chrome://tracing or Perfetto.
    if (process.env.KEEP_TRACE) {
      mkdirSync(process.env.KEEP_TRACE, { recursive: true });
      writeFileSync(join(process.env.KEEP_TRACE, `${tag}-${name}-${rate}x${playing ? '-playing' : ''}.trace.json`), JSON.stringify(trace));
    }
    // performance.now() and trace timestamps share a clock once the
    // navigation start is known.
    const origin = events.find((event) => event.name === 'navigationStart' && event.args?.data?.isOutermostMainFrame !== false && event.args?.data?.documentLoaderURL?.startsWith(server.origin))?.ts;
    const first = events.filter((event) => event.ts > 0).reduce((min, event) => Math.min(min, event.ts), Infinity);
    const last = events.reduce((max, event) => Math.max(max, event.ts ?? 0), 0);
    const window = origin ? { from: origin + started * 1000, to: origin + ended * 1000 } : { from: first, to: last };
    const scrolled = (await page.evaluate(() => [...document.querySelectorAll('*')].reduce((sum, element) => sum + element.scrollTop, 0))) - scrollBefore;
    if (scrolled < height) throw new Error(`${name}: the burst scrolled only ${scrolled}px — the wheel did not reach the list`);
    const page_state = await page.evaluate(() => ({ dom_elements: document.querySelectorAll('*').length, playing: navigator.mediaSession?.playbackState === 'playing' }));
    return { ...analyse(events, window), scrolled_px: Math.round(scrolled), ...page_state };
  } finally {
    await context.close();
  }
}

const gpu = await (async () => {
  const { context, page } = await open();
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await context.close();
  return renderer;
})();

const results = [];
try {
  for (const name of surfaces) for (const rate of rates) {
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) runs.push(await measure(name, rate));
    const row = { surface: name, playing, cpu_rate: rate, ...median(runs), runs: runs.map((run) => ({ presented: run.frames.presented, expected: run.frames.expected, dropped: run.frames.dropped, longest_task: run.main_thread_ms.longest_task })) };
    results.push(row);
    console.error(`${name} ${rate}× ${playing ? 'playing' : 'paused'}: ${row.frames.presented - row.frames.partial}/${row.frames.expected} complete frames, ${row.frames.partial} partial, ${row.frames.dropped} dropped, longest task ${row.main_thread_ms.longest_task} ms`);
  }
} finally {
  await browser.close();
  await server.close();
  if (!process.env.DIST) rmSync(work, { recursive: true, force: true });
}

const report = {
  tag, date: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  fixture: SIZES, viewport: { width, height }, input: { burst_ms: BURST_MS, wheel_interval_ms: WHEEL_INTERVAL_MS, wheel_delta_px: WHEEL_DELTA },
  browser: browser.version(), gpu, software, host: { cpu: cpus()[0]?.model, cores: cpus().length, load_1m: loadavg()[0] }, repeats, results,
};
const out = join(root, 'perf', 'results');
mkdirSync(out, { recursive: true });
const file = join(out, `${tag}.json`);
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(table(results));
console.error(`\n${file}\nGPU: ${gpu}`);
