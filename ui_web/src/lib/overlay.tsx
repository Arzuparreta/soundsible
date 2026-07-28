import { createSignal, For, onCleanup, onMount, type JSX, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import styles from './overlay.module.css';

type OverlayRender = (close: () => void) => JSX.Element;

interface OverlayEntry {
  id: number;
  render: OverlayRender;
  dismissable: boolean;
  ariaLabel?: string;
  returnFocus?: HTMLElement | null;
}

const [overlays, setOverlays] = createSignal<OverlayEntry[]>([]);
let nextId = 1;

function remove(id: number) {
  const entry = overlays().find((overlay) => overlay.id === id);
  setOverlays((list) => list.filter((o) => o.id !== id));
  queueMicrotask(() => entry?.returnFocus?.focus());
}

/**
 * The ONE place overlays (modals, sheets) mount. Returns a `close` handle.
 * Because entries live in a reactive registry rendered through a single
 * <Portal>, closing an overlay — or unmounting the app, or navigating away —
 * disposes its DOM, listeners and reactive scope automatically. The legacy
 * "document.body.appendChild a modal and forget it" leak is impossible here.
 */
export function openOverlay(
  render: OverlayRender,
  opts: { dismissable?: boolean; ariaLabel?: string } = {},
): () => void {
  const id = nextId++;
  setOverlays((list) => [
    ...list,
    {
      id,
      render,
      dismissable: opts.dismissable ?? true,
      ariaLabel: opts.ariaLabel,
      returnFocus: typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null,
    },
  ]);
  return () => remove(id);
}

/** Mounted once by the app shell. */
export const OverlayOutlet: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = overlays();
      const top = list[list.length - 1];
      if (!top) return;
      if (e.key === 'Escape' && top.dismissable) {
        remove(top.id);
        return;
      }
      if (e.key !== 'Tab') return;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 || import.meta.env.MODE === 'test');
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
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
              <div
                class={styles.sheet}
                role="dialog"
                aria-modal="true"
                aria-label={entry.ariaLabel}
                tabindex="-1"
                ref={(element) => {
                  queueMicrotask(() => {
                    const first = element.querySelector<HTMLElement>(
                      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
                    );
                    (first ?? element).focus();
                  });
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {entry.render(close)}
              </div>
            </div>
          );
        }}
      </For>
    </Portal>
  );
};
