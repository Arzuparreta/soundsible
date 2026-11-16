import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, median } from './trace.mjs';

const main = { pid: 7, tid: 1 };
const meta = { name: 'thread_name', ph: 'M', ...main, args: { name: 'CrRendererMain' } };
const task = (ts, dur, name = 'RunTask') => ({ name, ph: 'X', ...main, ts, dur });
const frame = (name, ts, args = {}) => ({ name, ph: 'I', pid: 7, tid: 2, ts, args });
const window = { from: 0, to: 1_000_000 };

test('frames are counted once each, with partial frames kept apart from complete ones', () => {
  const events = [
    meta, task(0, 10_000),
    frame('DrawFrame', 16_700), frame('DrawFrame', 33_400),
    frame('DroppedFrame', 50_100, { hasPartialUpdate: true }),
    frame('DroppedFrame', 66_800),
    frame('DrawFrame', 83_500),
    // A late frame is reported twice by PipelineReporter; neither counts.
    { name: 'PipelineReporter', ph: 'b', pid: 7, tid: 2, ts: 16_700, id2: { local: '0x1' }, args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } } },
  ];
  const result = analyse(events, window);
  assert.deepEqual(result.frames, { presented: 4, partial: 1, dropped: 1, expected: 5 });
  // Shown at 16.7, 33.4, 50.1 and 83.5 ms: the dropped frame is a 33.4 ms gap.
  assert.equal(result.display_gap_ms.max, 33.4);
  assert.equal(result.display_gap_ms.p50, 16.7);
});

test('main-thread time is a union, so nested work is not counted twice', () => {
  const events = [
    meta, task(0, 120_000),
    task(10_000, 60_000, 'EventDispatch'), task(20_000, 30_000, 'FunctionCall'),
    task(30_000, 5_000, 'Layout'), task(80_000, 10_000, 'Paint'),
  ];
  const { main_thread_ms } = analyse(events, window);
  assert.deepEqual(main_thread_ms, { longest_task: 120, tasks_over_50: 1, script: 60, layout: 5, paint: 10 });
});

test('the page is the renderer with the most task time, and events outside the window are ignored', () => {
  const spare = { name: 'thread_name', ph: 'M', pid: 9, tid: 1, args: { name: 'CrRendererMain' } };
  const events = [
    meta, spare, task(0, 40_000), { ...task(0, 5_000), pid: 9 },
    frame('DrawFrame', 10_000), { ...frame('DrawFrame', 10_000), pid: 9 }, frame('DrawFrame', 2_000_000),
  ];
  assert.equal(analyse(events, window).frames.presented, 1);
});

test('the reported run of a repeated case is the one with the median longest task', () => {
  const run = (longest_task) => ({ main_thread_ms: { longest_task } });
  assert.equal(median([run(300), run(10), run(40)]).main_thread_ms.longest_task, 40);
});
