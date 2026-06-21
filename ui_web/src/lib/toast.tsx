import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import styles from './toast.module.css';

export type ToastKind = 'success' | 'error' | 'info' | 'loading';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

const [toasts, setToasts] = createSignal<ToastEntry[]>([]);
let nextId = 1;

function dismiss(id: number): void {
  setToasts((list) => list.filter((t) => t.id !== id));
}

function push(kind: ToastKind, message: string, ttl: number): number {
  const id = nextId++;
  setToasts((list) => [...list, { id, kind, message }]);
  if (ttl > 0) setTimeout(() => dismiss(id), ttl);
  return id;
}

/** Handle returned by every toast call; lets a `loading` toast resolve into a
 * success/error in place (one moving notification, not a stack of three). */
export interface ToastHandle {
  readonly id: number;
  update(kind: ToastKind, message: string, ttl?: number): void;
  dismiss(): void;
}

function handle(id: number): ToastHandle {
  return {
    id,
    update(kind, message, ttl = 3000) {
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, kind, message } : t)));
      if (ttl > 0) setTimeout(() => dismiss(id), ttl);
    },
    dismiss: () => dismiss(id),
  };
}

/**
 * Lightweight toast notifications. There was no equivalent in the new UI; this
 * ports the legacy `shared.js` toasts onto a reactive registry rendered through
 * a single <Portal> (same pattern as overlay.tsx — no orphaned DOM).
 */
export const toast = {
  success: (m: string) => handle(push('success', m, 3000)),
  error: (m: string) => handle(push('error', m, 4500)),
  info: (m: string) => handle(push('info', m, 3000)),
  /** Persists until you `.update()` or `.dismiss()` the returned handle. */
  loading: (m: string) => handle(push('loading', m, 0)),
};

/** Mounted once by the app shell. */
export function ToastOutlet() {
  return (
    <Portal>
      <div class={styles.stack} role="status" aria-live="polite">
        <For each={toasts()}>
          {(t) => (
            <div classList={{ [styles.toast]: true, [styles[t.kind]]: true }}>
              <Show when={t.kind === 'loading'}>
                <span class={styles.spinner} aria-hidden="true" />
              </Show>
              <span class={styles.msg}>{t.message}</span>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
