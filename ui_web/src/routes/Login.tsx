import { Show, createSignal } from 'solid-js';
import Button from '../components/Button';
import { t } from '../lib/i18n';
import { login } from '../lib/session';
import styles from './Login.module.css';

/**
 * Shown instead of the app shell whenever the engine says a session is required
 * and we do not have one. Deliberately the whole screen: nothing behind it is
 * meaningful until we know whose library to load.
 */
export default function Login() {
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
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
            <input
              id="login-password"
              class={styles.input}
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
            />
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
