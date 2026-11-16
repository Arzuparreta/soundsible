/**
 * Reads one Chrome trace of a scroll burst into the numbers the web UI review
 * compares: frames by outcome, the time between displayed frames, and what the
 * renderer's main thread spent the interval on.
 */

const SCRIPT = new Set(['EvaluateScript', 'FunctionCall', 'RunMicrotasks', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'v8.callFunction']);
const LAYOUT = new Set(['Layout', 'UpdateLayoutTree']);
const PAINT = new Set(['PrePaint', 'Paint', 'Layerize', 'Commit']);

/** Total time covered by a set of possibly nested intervals, in ms. */
function union(events) {
  const spans = events.map((event) => [event.ts, event.ts + (event.dur ?? 0)]).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total / 1000;
}

const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const round = (value) => Math.round(value * 10) / 10;

export function analyse(events, window) {
  const inWindow = (event) => event.ts >= window.from && event.ts <= window.to;

  // The page's main thread: the CrRendererMain with the most task time. A
  // headless run has spare renderers; only one of them is scrolling.
  const mains = new Set(events.filter((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map((event) => `${event.pid}:${event.tid}`));
  const tasks = events.filter((event) => event.name === 'RunTask' && event.ph === 'X' && mains.has(`${event.pid}:${event.tid}`) && inWindow(event));
  const busy = new Map();
  for (const task of tasks) busy.set(`${task.pid}:${task.tid}`, (busy.get(`${task.pid}:${task.tid}`) ?? 0) + task.dur);
  const main = [...busy].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) throw new Error('No renderer main thread in the trace');
  const [pid] = main.split(':').map(Number);
  const onMain = (event) => `${event.pid}:${event.tid}` === main && event.ph === 'X' && inWindow(event);
  const mainTasks = tasks.filter(onMain);
  const named = (names) => events.filter((event) => names.has(event.name) && onMain(event));

  // The frame events the DevTools Performance panel draws its Frames track
  // from, emitted by the page's compositor: `DrawFrame` for a frame that was
  // shown, `DroppedFrame` for one that was not — or, with `hasPartialUpdate`,
  // one that was shown with the compositor's part (the scroll offset) but
  // without the main thread's (the rows that should have been there).
  // `PipelineReporter` is not used: it reports a late frame twice, once per
  // fork, and counting reporters doubles the frame rate.
  const frameEvents = events.filter((event) => event.pid === pid && inWindow(event) && (event.name === 'DrawFrame' || event.name === 'DroppedFrame'));
  const drawn = frameEvents.filter((event) => event.name === 'DrawFrame');
  const partialFrames = frameEvents.filter((event) => event.name === 'DroppedFrame' && event.args?.hasPartialUpdate);
  const dropped = frameEvents.length - drawn.length - partialFrames.length;
  const partial = partialFrames.length;
  const all = drawn.length;
  const shown = [...drawn, ...partialFrames].map((event) => event.ts).sort((a, b) => a - b);
  const gaps = shown.slice(1).map((ts, index) => (ts - shown[index]) / 1000).sort((a, b) => a - b);

  // What the whole pipeline spent, not only the page: a compositor animation
  // costs nothing on the main thread and still keeps three other threads awake.
  const threadNames = new Map(events.filter((event) => event.name === 'thread_name').map((event) => [`${event.pid}:${event.tid}`, event.args?.name]));
  const busyBy = (_label, match) => round(union(events.filter((event) => event.name === 'RunTask' && event.ph === 'X' && inWindow(event) && match(event, threadNames.get(`${event.pid}:${event.tid}`)))));
  const threads_busy_ms = {
    main: busyBy('main', (event) => `${event.pid}:${event.tid}` === main),
    compositor: busyBy('compositor', (event, name) => event.pid === pid && name === 'Compositor'),
    gpu: busyBy('gpu', (_, name) => name === 'CrGpuMain'),
    display: busyBy('display', (_, name) => name === 'VizCompositorThread'),
  };

  return {
    threads_busy_ms,
    frames: { presented: all + partial, partial, dropped, expected: all + partial + dropped },
    display_gap_ms: { p50: round(percentile(gaps, 0.5)), p95: round(percentile(gaps, 0.95)), max: round(gaps.at(-1) ?? 0) },
    main_thread_ms: {
      longest_task: round(Math.max(0, ...mainTasks.map((task) => task.dur)) / 1000),
      tasks_over_50: mainTasks.filter((task) => task.dur > 50_000).length,
      script: round(union(named(SCRIPT))),
      layout: round(union(named(LAYOUT))),
      paint: round(union(named(PAINT))),
    },
  };
}

/** The middle run of a repeated measurement, picked by its longest task. */
export function median(runs) {
  const sorted = [...runs].sort((a, b) => a.main_thread_ms.longest_task - b.main_thread_ms.longest_task);
  return sorted[Math.floor(sorted.length / 2)];
}
