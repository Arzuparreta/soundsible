import { SettingsLoad } from './SettingsLoad';
import { createSignal } from 'solid-js';
import { api, type SubsonicAccess } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import { SubsonicAccessView } from './SubsonicAccessView';

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
    setAccess(await api.getSubsonicAccess());
  };

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
    <SettingsLoad load={load}>
      <SubsonicAccessView access={access()} password={password()} busy={busy()} serverUrl={serverUrl()}
        onGenerate={() => void generate()} onRevoke={() => void revoke()}
        onCopyServer={() => void copy(serverUrl())} onCopyPassword={() => void copy(password())} />
    </SettingsLoad>
  );
}
