import { createEffect, createSignal, onCleanup } from 'solid-js';

/** Let a new view's controls and loading shape paint before building a grid.
 * No minimum spinner duration. Cancel obsolete work on rapid navigation. */
export function afterPaint(key: () => unknown) {
  const [painted, setPainted] = createSignal<{ key: unknown }>();
  createEffect(() => {
    const current = key();
    setPainted(undefined);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPainted({ key: current }));
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  // Compare synchronously: render computations run before effects. A plain
  // boolean can briefly mount the next grid with the previous tab's readiness.
  return () => painted() !== undefined && painted()!.key === key();
}
