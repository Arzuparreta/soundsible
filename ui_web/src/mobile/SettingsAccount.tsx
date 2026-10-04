import { createSignal, onCleanup } from 'solid-js';
import { AccountSettingsView } from '../components/AccountSettingsView';
import { createNativeAccountMutations } from './accountMutations';
import { promptDialog } from '../lib/prompt';
import { passwordDialog } from '../lib/passwordDialog';
import { confirmDialog } from '../lib/confirm';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { User } from '../lib/session';
import type { createSearchHistoryStorage } from '../lib/searchHistoryStorage';

export default function NativeSettingsAccount(props: {
  user: User; identity: () => number; available: () => boolean; signal: AbortSignal; busy?: boolean;
  history: ReturnType<typeof createSearchHistoryStorage>;
  onUser: (user: User) => Promise<void>; onLogout: () => Promise<void>;
}) {
  const [pending, setPending] = createSignal(false);
  const parent = props.signal, controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true });
  let disposed = false;
  onCleanup(() => { disposed = true; controller.abort(); parent.removeEventListener('abort', abort); });
  const mutations = createNativeAccountMutations(props.identity, () => props.user,
    () => !disposed && props.available() && !controller.signal.aborted, () => controller.signal, props.onUser);
  async function edit(kind: 'name' | 'username' | 'password') {
    if (pending() || props.busy || !props.available() || disposed || controller.signal.aborted) return;
    const epoch = props.identity(), owner = props.user.id;
    const current = () => !disposed && !controller.signal.aborted && props.identity() === epoch && props.user.id === owner && props.available();
    setPending(true);
    try {
      let confirmed = false;
      if (kind === 'password') {
        const previous = props.user.has_password ? await promptDialog({ title: t('account.changePassword'), inputLabel: t('account.currentPassword'), confirmLabel: t('common.continue') }, current) : '';
        if (previous === null || !current()) return;
        const next = await passwordDialog({ title: t('account.changePassword'), message: t('account.passwordHint'), confirmLabel: t('common.save') });
        if (!next || !current()) return;
        confirmed = await mutations.password(previous, next);
      } else {
        const initial = kind === 'name' ? props.user.display_name : props.user.username;
        const next = await promptDialog({ title: t(kind === 'name' ? 'account.changeName' : 'account.changeUsername'),
          inputLabel: t(kind === 'name' ? 'account.name' : 'account.username'), initial,
          message: kind === 'username' ? t('account.usernameHint') : undefined, confirmLabel: t('common.save') }, current);
        if (!next || next === initial || !current()) return;
        confirmed = await mutations.profile(kind === 'name' ? { display_name: next } : { username: next });
      }
      if (confirmed && current()) toast.success(t(kind === 'name' ? 'account.nameChanged' : kind === 'username' ? 'account.usernameChanged' : 'account.passwordChanged'));
    } catch {
      if (current()) toast.error(t(kind === 'name' ? 'account.nameFailed' : kind === 'username' ? 'account.usernameFailed' : 'account.passwordFailedHint'));
    } finally { if (!disposed) setPending(false); }
  }
  async function logout() {
    if (pending() || props.busy || disposed) return;
    const epoch = props.identity(), owner = props.user.id;
    const current = () => !disposed && props.identity() === epoch && props.user.id === owner;
    const confirmed = await confirmDialog({ title: t('account.signOut'), message: t('account.signOutConfirm'), confirmLabel: t('account.signOut') }, current);
    if (confirmed && current()) await props.onLogout();
  }
  return <section data-testid="android-settings-account">
    <h2>{t('account.title')}</h2>
    <AccountSettingsView user={props.user} pending={pending() || props.busy} disabled={pending() || props.busy || !props.available()}
      historyEnabled={props.history.enabled()} onHistoryChange={() => { if (!disposed) props.history.setEnabled(!props.history.enabled()); }}
      onName={() => void edit('name')} onUsername={() => void edit('username')} onPassword={() => void edit('password')} onLogout={() => void logout()} />
  </section>;
}
