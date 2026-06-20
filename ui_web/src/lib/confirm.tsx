import { onCleanup, Show } from 'solid-js';
import { openOverlay } from './overlay';
import styles from './confirm.module.css';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Promise-based confirmation dialog over `openOverlay`. Resolves `true` on
 * confirm, `false` on cancel OR scrim-dismiss — the dismissal path is caught via
 * `onCleanup`, which fires when the overlay entry's reactive scope is disposed.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openOverlay((close) => {
      onCleanup(() => settle(false));
      const choose = (value: boolean) => {
        settle(value);
        close();
      };
      return (
        <div class={styles.dialog}>
          <h2 class={styles.title}>{opts.title}</h2>
          <Show when={opts.message}>
            <p class={styles.message}>{opts.message}</p>
          </Show>
          <div class={styles.actions}>
            <button type="button" class={styles.cancel} onClick={() => choose(false)}>
              {opts.cancelLabel ?? 'Cancelar'}
            </button>
            <button
              type="button"
              classList={{ [styles.confirm]: true, [styles.danger]: opts.danger }}
              onClick={() => choose(true)}
            >
              {opts.confirmLabel ?? 'Aceptar'}
            </button>
          </div>
        </div>
      );
    });
  });
}
