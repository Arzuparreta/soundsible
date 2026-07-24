import { Show, createSignal, onCleanup } from 'solid-js';
import { openOverlay } from './overlay';
import { t } from './i18n';
import PasswordFields from '../components/PasswordFields';
import styles from './confirm.module.css';

/**
 * Modal for setting a password: two fields (set + repeat) with a show/hide
 * toggle. Resolves the confirmed password, or `null` on cancel or dismiss.
 * Confirm stays disabled until the two entries match.
 */
export function passwordDialog(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openOverlay((close) => {
      onCleanup(() => settle(null));
      const [password, setPassword] = createSignal<string | null>(null);
      const done = (value: string | null) => {
        settle(value);
        close();
      };
      return (
        <div class={styles.dialog}>
          <h2 class={styles.title}>{opts.title}</h2>
          <Show when={opts.message}>
            <p class={styles.message}>{opts.message}</p>
          </Show>
          <PasswordFields onChange={setPassword} />
          <div class={styles.actions}>
            <button type="button" class={styles.cancel} onClick={() => done(null)}>
              {t('confirm.cancel')}
            </button>
            <button
              type="button"
              class={styles.confirm}
              disabled={!password()}
              onClick={() => done(password())}
            >
              {opts.confirmLabel ?? t('common.save')}
            </button>
          </div>
        </div>
      );
    });
  });
}
