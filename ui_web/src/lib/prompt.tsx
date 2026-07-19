import { onCleanup, createSignal, Show } from 'solid-js';
import { openOverlay } from './overlay';
import { t } from './i18n';
import styles from './prompt.module.css';

export interface PromptOptions {
  title: string;
  message?: string;
  initial?: string;
  placeholder?: string;
  inputLabel?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, confirm stays disabled until the trimmed input equals this value. */
  match?: string;
}

/** Single-line text prompt over `openOverlay`. Resolves the trimmed value, or
 * `null` on cancel/dismiss. Used for playlist create/rename and typed confirms. */
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
      const matched = () => (opts.match === undefined ? true : val().trim() === opts.match);
      const finish = (v: string | null) => {
        settle(v);
        close();
      };
      const submit = (e: Event) => {
        e.preventDefault();
        if (!matched()) return;
        finish(val().trim() || null);
      };
      return (
        <form class={styles.form} onSubmit={submit}>
          <h2 class={styles.title}>{opts.title}</h2>
          <Show when={opts.message}>
            <p class={styles.message}>{opts.message}</p>
          </Show>
          <label class={styles.field}>
            <Show when={opts.inputLabel}>
              <span class={styles.inputLabel}>{opts.inputLabel}</span>
            </Show>
            <input
              class={styles.input}
              type="text"
              inputmode={opts.match !== undefined ? 'numeric' : undefined}
              autofocus
              value={val()}
              placeholder={opts.placeholder}
              onInput={(e) => setVal(e.currentTarget.value)}
            />
          </label>
          <div class={styles.actions}>
            <button type="button" class={styles.cancel} onClick={() => finish(null)}>
              {t('prompt.cancel')}
            </button>
            <button
              type="submit"
              classList={{ [styles.confirm]: true, [styles.danger]: opts.danger }}
              disabled={!matched()}
            >
              {opts.confirmLabel ?? t('prompt.save')}
            </button>
          </div>
        </form>
      );
    });
  });
}
