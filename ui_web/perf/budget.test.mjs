import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget } from './budget.mjs';

const report = () => ({ fixture: { tracks: 6000 }, viewport: { height: 768 }, input: { kind: 'wheel' },
  results: ['songs', 'albums', 'player-queue'].map(surface => ({ surface, cpu_rate: 1,
    dom_elements: 1000, scrolled_px: 5000, frames: { presented: 100, partial: 50 } })) });

test('the CI budget accepts different frame rates while enforcing bounded collections', () => {
  const value = report();
  value.results[0].frames.presented = 2;
  checkBudget(value);
  value.results[0].dom_elements = 60000;
  assert.throws(() => checkBudget(value), /DOM budget/);
});
test('a missing surface or a wheel that never reached the collection fails', () => {
  const value = report();
  value.results[1].scrolled_px = 0;
  assert.throws(() => checkBudget(value), /no rendered scroll/);
  value.results.pop();
  value.results[1].scrolled_px = 1000;
  assert.throws(() => checkBudget(value), /Missing rendering case/);
});
test('missing or nonnumeric scroll/frame evidence cannot pass', () => {
  assert.throws(() => checkBudget({ ...report(), fixture: {} }), /large scrolling fixture/);
  for (const field of ['scrolled_px', 'frames']) {
    const value = report();
    delete value.results[0][field];
    assert.throws(() => checkBudget(value), /no rendered scroll/);
  }
});
