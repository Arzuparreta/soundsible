import { createResource, createSignal, onCleanup, Show } from 'solid-js';
import PasswordFields from '../components/PasswordFields';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import styles from './AndroidStart.module.css';

export default function NativeInvite(props: { token: string; current: () => boolean; onAccepted: () => Promise<void>; onCancel: () => void }) {
  const controller = new AbortController();
  let alive = true;
  onCleanup(() => { alive = false; controller.abort(); });
  const current = () => alive && props.current() && !controller.signal.aborted;
  const [username, setUsername] = createSignal(''), [password, setPassword] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  const [preview] = createResource(() => props.token, async token => {
    try { return await request<{ valid: boolean }>(`/api/invites/${encodeURIComponent(token)}/preview`, { signal: controller.signal }); }
    catch { return { valid: false }; }
  });
  async function accept(event: SubmitEvent) {
    event.preventDefault();
    if (!current() || busy() || !preview()?.valid || !password() || !username().trim()) return;
    setBusy(true); setError('');
    try {
      await request(`/api/invites/${encodeURIComponent(props.token)}/accept`, { method: 'POST',
        body: { username: username().trim(), password: password(), device_name: 'Soundsible Android' }, signal: controller.signal });
      setPassword(null);
      if (current()) await props.onAccepted();
    } catch { if (current()) setError(t('invite.failed')); }
    finally { if (current()) setBusy(false); }
  }
  return <section data-native-invite>
    <h2>{t(preview.loading ? 'common.loading' : preview()?.valid ? 'invite.title' : 'invite.invalidTitle')}</h2>
    <Show when={!preview.loading}><p>{t(preview()?.valid ? 'invite.blurb' : 'invite.invalidBlurb')}</p></Show>
    <Show when={preview()?.valid}><form class={styles.form} onSubmit={accept}>
      <label class={styles.field}>{t('invite.username')}<input autocomplete="username" autocapitalize="none" required
        value={username()} disabled={busy()} onInput={event => setUsername(event.currentTarget.value)} /></label>
      <fieldset disabled={busy()}><PasswordFields onChange={setPassword} newLabel={t('invite.password')} /></fieldset>
      <button disabled={busy() || !password() || !username().trim()}>{t(busy() ? 'invite.creating' : 'invite.create')}</button>
    </form></Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <button disabled={busy()} onClick={() => { if (current()) props.onCancel(); }}>{t('common.cancel')}</button>
  </section>;
}
