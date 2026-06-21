import { onCleanup, createSignal } from 'solid-js';
import { openOverlay } from './overlay';
import styles from './prompt.module.css';

export interface PromptOptions {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}

/** Single-line text prompt over `openOverlay`. Resolves the trimmed value, or
 * `null` on cancel/dismiss. Used for playlist create/rename. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openOverlay((close) => {
      onCleanup(() => settle(null));
      const [val, setVal] = createSignal(opts.initial ?? '');
      const finish = (v: string | null) => {
        settle(v);
        close();
      };
      const submit = (e: Event) => {
        e.preventDefault();
        finish(val().trim() || null);
      };
      return (
        <form class={styles.form} onSubmit={submit}>
          <h2 class={styles.title}>{opts.title}</h2>
          <input
            class={styles.input}
            type="text"
            autofocus
            value={val()}
            placeholder={opts.placeholder}
            onInput={(e) => setVal(e.currentTarget.value)}
          />
          <div class={styles.actions}>
            <button type="button" class={styles.cancel} onClick={() => finish(null)}>
              Cancelar
            </button>
            <button type="submit" class={styles.confirm}>
              {opts.confirmLabel ?? 'Guardar'}
            </button>
          </div>
        </form>
      );
    });
  });
}
