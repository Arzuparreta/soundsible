import { Show, createSignal } from 'solid-js';
import Button from '../components/Button';
import { t } from '../lib/i18n';
import { login } from '../lib/session';
import styles from './Login.module.css';

function EyeIcon(shown: boolean) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      {shown ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 6.2A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 7.8A17 17 0 0 0 2 12s3.6 6 10 6a9.6 9.6 0 0 0 3.3-.6" />
        </>
      ) : (
        <>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * Shown instead of the app shell whenever the engine says a session is required
 * and we do not have one. Deliberately the whole screen: nothing behind it is
 * meaningful until we know whose library to load.
 */
export default function Login() {
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [showPw, setShowPw] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setError('');
    setBusy(true);
    try {
      await login(username().trim(), password());
      // Reload so every store starts clean for the account that just signed in.
      window.location.reload();
    } catch {
      setError(t('login.failed'));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div class={styles.brand}>
          <img class={styles.mark} src="/player/branding/logo-app.png" alt="" />
          <h1 class={styles.title}>{t('login.title')}</h1>
          <p class={styles.blurb}>{t('login.blurb')}</p>
        </div>

        <form class={styles.form} onSubmit={submit}>
          <div class={styles.field}>
            <label class={styles.label} for="login-username">
              {t('login.username')}
            </label>
            <input
              id="login-username"
              class={styles.input}
              type="text"
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              required
            />
          </div>

          <div class={styles.field}>
            <label class={styles.label} for="login-password">
              {t('login.password')}
            </label>
            <div class={styles.inputRow}>
              <input
                id="login-password"
                class={styles.input}
                type={showPw() ? 'text' : 'password'}
                autocomplete="current-password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                required
              />
              <button
                type="button"
                class={styles.toggle}
                aria-pressed={showPw()}
                aria-label={showPw() ? t('password.hide') : t('password.show')}
                onClick={() => setShowPw(!showPw())}
              >
                {EyeIcon(showPw())}
              </button>
            </div>
          </div>

          <Show when={error()}>
            <p class={styles.error} role="alert">
              {error()}
            </p>
          </Show>

          <Button class={styles.submit} type="submit" disabled={busy()}>
            {busy() ? t('login.signingIn') : t('login.signIn')}
          </Button>
        </form>
      </div>
    </div>
  );
}
