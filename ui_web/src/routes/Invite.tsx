import { Match, Show, Switch, createResource, createSignal } from 'solid-js';
import Button from '../components/Button';
import { t } from '../lib/i18n';
import { invites } from '../lib/session';
import styles from './Login.module.css';

/**
 * Redeeming an invitation. Public: whoever opens the link has no account yet.
 *
 * Deliberately says nothing about the server or anybody else on it — it reads
 * as "set up your player", which is all the person needs to know.
 */
export default function Invite(props: { token: string }) {
  const [preview] = createResource<{ valid: boolean }, string>(
    () => props.token,
    (token) => invites.preview(token).catch(() => ({ valid: false })),
  );
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
      await invites.accept(props.token, username().trim(), password());
      // Straight into the player, already signed in.
      window.location.hash = '#/';
      window.location.reload();
    } catch {
      setError(t('invite.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div class={styles.brand}>
          <img class={styles.mark} src="/player/branding/logo-app.png" alt="" />
          <Switch>
            <Match when={preview.loading}>
              <h1 class={styles.title}>{t('common.loading')}</h1>
            </Match>
            <Match when={!preview()?.valid}>
              <h1 class={styles.title}>{t('invite.invalidTitle')}</h1>
              <p class={styles.blurb}>{t('invite.invalidBlurb')}</p>
            </Match>
            <Match when={preview()?.valid}>
              <h1 class={styles.title}>{t('invite.title')}</h1>
              <p class={styles.blurb}>{t('invite.blurb')}</p>
            </Match>
          </Switch>
        </div>

        <Show when={preview()?.valid}>
          <form class={styles.form} onSubmit={submit}>
            <div class={styles.field}>
              <label class={styles.label} for="invite-username">
                {t('invite.username')}
              </label>
              <input
                id="invite-username"
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
              <label class={styles.label} for="invite-password">
                {t('invite.password')}
              </label>
              <input
                id="invite-password"
                class={styles.input}
                type="password"
                autocomplete="new-password"
                minLength={6}
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                required
              />
              <span class={styles.hint}>{t('invite.passwordHint')}</span>
            </div>

            <Show when={error()}>
              <p class={styles.error} role="alert">
                {error()}
              </p>
            </Show>

            <Button class={styles.submit} type="submit" disabled={busy()}>
              {busy() ? t('invite.creating') : t('invite.create')}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  );
}
