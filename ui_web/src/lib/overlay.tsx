import { createSignal, For, onCleanup, onMount, type JSX, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import styles from './overlay.module.css';

type OverlayRender = (close: () => void) => JSX.Element;

interface OverlayEntry {
  id: number;
  render: OverlayRender;
  dismissable: boolean;
}

const [overlays, setOverlays] = createSignal<OverlayEntry[]>([]);
let nextId = 1;

function remove(id: number) {
  setOverlays((list) => list.filter((o) => o.id !== id));
}

/**
 * The ONE place overlays (modals, sheets) mount. Returns a `close` handle.
 * Because entries live in a reactive registry rendered through a single
 * <Portal>, closing an overlay — or unmounting the app, or navigating away —
 * disposes its DOM, listeners and reactive scope automatically. The legacy
 * "document.body.appendChild a modal and forget it" leak is impossible here.
 */
export function openOverlay(render: OverlayRender, opts: { dismissable?: boolean } = {}): () => void {
  const id = nextId++;
  setOverlays((list) => [...list, { id, render, dismissable: opts.dismissable ?? true }]);
  return () => remove(id);
}

/** Mounted once by the app shell. */
export const OverlayOutlet: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const list = overlays();
      const top = list[list.length - 1];
      if (top && top.dismissable) remove(top.id);
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <Portal>
      <For each={overlays()}>
        {(entry) => {
          const close = () => remove(entry.id);
          return (
            <div
              class={styles.scrim}
              onClick={() => entry.dismissable && close()}
              role="presentation"
            >
              <div class={styles.sheet} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                {entry.render(close)}
              </div>
            </div>
          );
        }}
      </For>
    </Portal>
  );
};
