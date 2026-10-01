import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json')));
const baseline = JSON.parse(readFileSync(resolve(root, '../docs/performance/web-payload-baseline.json')));
function graph(entries) {
  const visited = new Set(), files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing manifest entry ${key}`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  }
  entries.forEach(visit);
  let raw_bytes = 0, gzip_bytes = 0, brotli_bytes = 0;
  for (const file of files) {
    const path = resolve(dist, file), raw = readFileSync(path);
    raw_bytes += raw.length;
    gzip_bytes += existsSync(path + '.gz') ? readFileSync(path + '.gz').length : gzipSync(raw, { level: 9 }).length;
    brotli_bytes += existsSync(path + '.br') ? readFileSync(path + '.br').length : brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
  }
  return { raw_bytes, gzip_bytes, brotli_bytes, files: [...files].sort() };
}
const build_id = readFileSync(resolve(dist, 'index.html'), 'utf8').match(/<meta name="soundsible-build" content="([a-f0-9]{64})"/)?.[1];
const report = { build_id, baseline_revision: baseline.revision, method: 'Production manifest static JS/CSS dependency closure; excludes fonts, locale dictionaries, dynamic routes and API. Gzip level 9, Brotli quality 5.', login: graph(['index.html']), library: graph(['index.html', 'src/AuthenticatedPlayer.tsx']) };
for (const [name, ceiling] of [['login', 0.50], ['library', 0.85]]) {
  report[name].gzip_reduction_percent = +(100 * (1 - report[name].gzip_bytes / baseline.initial.gzip_bytes)).toFixed(2);
  if (report[name].gzip_bytes > baseline.initial.gzip_bytes * ceiling) throw new Error(`${name} exceeds approved gzip budget: ${report[name].gzip_bytes}`);
}
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--record')) writeFileSync(resolve(root, '../docs/performance/web-payload-after.json'), JSON.stringify(report, null, 2) + '\n');
