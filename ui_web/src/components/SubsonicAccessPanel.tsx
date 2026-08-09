import { createSignal, onMount, Show } from 'solid-js';
import { api, type SubsonicAccess } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import { ActionRow, SettingRow, SettingsGroup, ValueRow } from './SettingsRows';
import styles from './SettingsSections.module.css';

/**
 * Connecting another app to this library.
 *
 * The password here is not the account password and cannot be looked up later:
 * the engine keeps it encrypted, and the Subsonic handshake is the only reason
 * it can be read back at all. So it is shown once, at the moment it is made,
 * with a copy button next to it — and the panel says plainly that generating a
 * new one stops every app still using the old.
 */
export function SubsonicAccessPanel() {
  const [access, setAccess] = createSignal<SubsonicAccess | null>(null);
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const load = async () => {
    try {
      setAccess(await api.getSubsonicAccess());
    } catch {
      setAccess(null);
    }
  };
  onMount(() => void load());

  // The address the browser reached the engine on is the one that works for a
  // phone on the same network, which is exactly what needs pasting.
  const serverUrl = () => window.location.origin;

  const generate = async () => {
    if (
      access()?.configured &&
      !(await confirmDialog({
        title: t('subsonic.replaceTitle'),
        message: t('subsonic.replaceMessage'),
        confirmLabel: t('subsonic.generate'),
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const created = await api.createSubsonicAccess();
      setAccess(created);
      setPassword(created.password);
    } catch {
      toast.error(t('settings.toast.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const confirmed = await confirmDialog({
      title: t('subsonic.revokeTitle'),
      message: t('subsonic.revokeMessage'),
      confirmLabel: t('subsonic.revoke'),
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      setAccess(await api.revokeSubsonicAccess());
      setPassword('');
    } catch {
      toast.error(t('settings.toast.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    if (await copyText(value)) toast.success(t('social.copied'));
    else toast.error(t('subsonic.copyFailed'));
  };

  return (
    <>
      <SettingsGroup label={t('subsonic.title')} note={t('subsonic.note')}>
        <ValueRow label={t('subsonic.server')} value={<span class={styles.mono}>{serverUrl()}</span>} />
        <ValueRow
          label={t('subsonic.username')}
          value={<span class={styles.mono}>{access()?.username ?? '—'}</span>}
        />
        <ActionRow label={t('subsonic.copyServer')} onClick={() => void copy(serverUrl())} />
      </SettingsGroup>

      <SettingsGroup label={t('subsonic.password')} note={t('subsonic.passwordNote')}>
        <Show when={password()}>
          <SettingRow
            label={t('subsonic.passwordShownOnce')}
            hint={t('subsonic.passwordShownOnceHint')}
          >
            <span class={styles.secret}>{password()}</span>
          </SettingRow>
          <ActionRow label={t('subsonic.copyPassword')} onClick={() => void copy(password())} />
        </Show>
        <ActionRow
          label={access()?.configured ? t('subsonic.regenerate') : t('subsonic.generate')}
          hint={access()?.configured ? t('subsonic.regenerateHint') : t('subsonic.generateHint')}
          onClick={() => void generate()}
          disabled={busy()}
        />
        <Show when={access()?.configured}>
          <ActionRow
            label={t('subsonic.revoke')}
            hint={t('subsonic.revokeHint')}
            onClick={() => void revoke()}
            disabled={busy()}
            danger
          />
        </Show>
      </SettingsGroup>

      <Show when={access()?.configured}>
        <SettingsGroup label={t('subsonic.usage')}>
          <ValueRow
            label={t('subsonic.lastUsed')}
            value={access()?.last_used_at ?? t('subsonic.never')}
          />
          <Show when={access()?.last_client}>
            <ValueRow label={t('subsonic.lastClient')} value={access()!.last_client!} />
          </Show>
        </SettingsGroup>
      </Show>
    </>
  );
}
