import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkBudget(report, maximum = 1800) {
  if (!Number.isFinite(report.fixture?.tracks) || report.fixture.tracks < 6000
      || report.input?.kind !== 'wheel') throw new Error('The rendering budget needs the large scrolling fixture');
  for (const surface of ['songs', 'albums', 'player-queue']) {
    const row = report.results.find(item => item.surface === surface && item.cpu_rate === 1);
    if (!row) throw new Error(`Missing rendering case: ${surface}`);
    if (!Number.isFinite(row.dom_elements) || row.dom_elements > maximum) throw new Error(`${surface}: DOM budget exceeded (${row.dom_elements}, maximum ${maximum})`);
    if (!Number.isFinite(row.scrolled_px) || row.scrolled_px < report.viewport.height
        || !Number.isFinite(row.frames?.presented) || row.frames.presented < 1) throw new Error(`${surface}: no rendered scroll observed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkBudget(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log('Production collection DOM and scroll budgets passed; frame timings are recorded separately.');
}
