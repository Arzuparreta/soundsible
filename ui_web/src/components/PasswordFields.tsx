import { Show, createEffect, createSignal, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import styles from './PasswordFields.module.css';

function EyeIcon(shown: boolean): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <Show
        when={shown}
        fallback={
          <>
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </>
        }
      >
        <path d="M3 3l18 18" />
        <path d="M10.6 6.2A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 7.8A17 17 0 0 0 2 12s3.6 6 10 6a9.6 9.6 0 0 0 3.3-.6" />
      </Show>
    </svg>
  );
}

/**
 * Two password inputs — set and repeat — with one show/hide toggle that reveals
 * both. Emits the password when the two match and are non-empty, otherwise
 * `null`, so the parent can gate its submit on a confirmed value. There is no
 * length rule; an empty password is simply "not yet valid".
 */
export default function PasswordFields(props: {
  onChange: (password: string | null) => void;
  newLabel?: string;
  autocomplete?: string;
}) {
  const [pw, setPw] = createSignal('');
  const [repeat, setRepeat] = createSignal('');
  const [show, setShow] = createSignal(false);

  const mismatch = () => repeat().length > 0 && pw() !== repeat();
  createEffect(() => props.onChange(pw().length > 0 && pw() === repeat() ? pw() : null));

  const type = () => (show() ? 'text' : 'password');
  const autocomplete = () => props.autocomplete ?? 'new-password';

  return (
    <div class={styles.wrap}>
      <div class={styles.field}>
        <label class={styles.label}>{props.newLabel ?? t('password.new')}</label>
        <div class={styles.inputRow}>
          <input
            class={styles.input}
            type={type()}
            autocomplete={autocomplete()}
            value={pw()}
            onInput={(e) => setPw(e.currentTarget.value)}
          />
          <button
            type="button"
            class={styles.toggle}
            aria-pressed={show()}
            aria-label={show() ? t('password.hide') : t('password.show')}
            onClick={() => setShow(!show())}
          >
            {EyeIcon(show())}
          </button>
        </div>
      </div>

      <div class={styles.field}>
        <label class={styles.label}>{t('password.repeat')}</label>
        <input
          class={styles.input}
          type={type()}
          autocomplete={autocomplete()}
          value={repeat()}
          onInput={(e) => setRepeat(e.currentTarget.value)}
        />
      </div>

      <Show when={mismatch()}>
        <p class={styles.mismatch}>{t('password.mismatch')}</p>
      </Show>
    </div>
  );
}
