import { For, Show, createResource, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import Button from '../components/Button';
import { ViewHeader } from '../components/ViewHeader';
import { confirmDialog } from '../lib/confirm';
import { passwordDialog } from '../lib/passwordDialog';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import PasswordFields from '../components/PasswordFields';
import { invites, isAdmin, user, users, type Role, type User } from '../lib/session';
import styles from './Users.module.css';

function initials(person: User): string {
  return (person.display_name || person.username).trim().slice(0, 1);
}

/**
 * Account management. Admin-only — the engine enforces it too, this just keeps
 * the door shut in the UI rather than showing 403s.
 */
export default function Users_() {
  const navigate = useNavigate();
  const [list, { refetch }] = createResource(async () => (await users.list()).users);
  const [username, setUsername] = createSignal('');
  const [displayName, setDisplayName] = createSignal('');
  const [password, setPassword] = createSignal<string | null>(null);
  const [role, setRole] = createSignal<Role>('member');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [inviteLink, setInviteLink] = createSignal('');

  const me = () => user();
  const needsOwnPassword = () => me() != null && !me()!.has_password;

  const create = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setError('');
    setBusy(true);
    try {
      await users.create({
        username: username().trim(),
        password: password() || undefined,
        display_name: displayName().trim() || undefined,
        role: role(),
      });
      setPassword(null);
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('member');
      toast.success(t('users.created'));
      void refetch();
    } catch {
      setError(t('users.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    // The link is anonymous — no name is attached. Whoever opens it picks their
    // own. So this is one tap: generate and copy.
    try {
      const { url } = await invites.create();
      setInviteLink(url);
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t('users.inviteCopied'));
      } catch {
        // Clipboard is blocked on plain HTTP in some browsers — the link stays
        // on screen so it can still be selected by hand.
        toast.info(t('users.inviteReady'));
      }
    } catch {
      toast.error(t('users.inviteFailed'));
    }
  };

  const resetPassword = async (person: User) => {
    const next = await passwordDialog({
      title: t('users.resetPasswordTitle', { name: person.display_name }),
      message: t('users.resetPasswordMsg'),
      confirmLabel: t('common.save'),
    });
    if (!next) return;
    try {
      await users.setPassword(person.id, next);
      toast.success(t('users.passwordUpdated'));
      void refetch();
    } catch {
      toast.error(t('users.passwordFailed'));
    }
  };

  const toggleDisabled = async (person: User) => {
    try {
      await users.update(person.id, { disabled: !person.disabled });
      void refetch();
    } catch {
      toast.error(t('users.updateFailed'));
    }
  };

  const remove = async (person: User) => {
    const ok = await confirmDialog({
      title: t('users.deleteTitle', { name: person.display_name }),
      message: t('users.deleteMsg'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await users.remove(person.id);
      toast.success(t('users.deleted'));
      void refetch();
    } catch {
      toast.error(t('users.deleteFailed'));
    }
  };

  return (
    <section class={styles.page}>
      <ViewHeader title={t('users.title')} />

      <Show
        when={isAdmin()}
        fallback={<p class={styles.intro}>{t('users.adminOnly')}</p>}
      >
        <p class={styles.intro}>{t('users.intro')}</p>

        <Show when={needsOwnPassword()}>
          <p class={styles.notice}>{t('users.setYourPasswordFirst')}</p>
        </Show>

        <div class={styles.inviteBar}>
          <Button onClick={invite} disabled={needsOwnPassword()}>
            {t('users.invite')}
          </Button>
          <Show when={inviteLink()}>
            <input class={styles.inviteLink} readOnly value={inviteLink()} onFocus={(e) => e.currentTarget.select()} />
          </Show>
        </div>
        <Show when={inviteLink()}>
          <p class={styles.intro}>{t('users.inviteHint')}</p>
        </Show>

        <ul class={styles.list}>
          <For each={list() ?? []}>
            {(person) => (
              <li class={styles.row}>
                <span
                  class={styles.avatar}
                  style={{ background: person.avatar_color ?? 'var(--accent)' }}
                  aria-hidden="true"
                >
                  {initials(person)}
                </span>
                <span class={styles.identity}>
                  <span class={styles.name}>{person.display_name}</span>
                  <span class={styles.meta}>
                    <span>@{person.username}</span>
                    <Show when={person.role === 'admin'}>
                      <span class={styles.badge}>{t('users.roleAdmin')}</span>
                    </Show>
                    <Show when={!person.has_password}>
                      <span class={styles.badgeMuted}>{t('users.noPassword')}</span>
                    </Show>
                    <Show when={person.disabled}>
                      <span class={styles.badgeMuted}>{t('users.disabled')}</span>
                    </Show>
                  </span>
                </span>
                <span class={styles.rowActions}>
                  <Button size="sm" variant="ghost" onClick={() => resetPassword(person)}>
                    {t('users.setPassword')}
                  </Button>
                  <Show when={person.id !== me()?.id}>
                    <Button size="sm" variant="ghost" onClick={() => toggleDisabled(person)}>
                      {person.disabled ? t('users.enable') : t('users.disable')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(person)}>
                      {t('common.delete')}
                    </Button>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>

        <form class={styles.form} onSubmit={create}>
          <h2 class={styles.formTitle}>{t('users.addTitle')}</h2>

          <div class={styles.field}>
            <label class={styles.label} for="new-username">
              {t('users.username')}
            </label>
            <input
              id="new-username"
              class={styles.input}
              type="text"
              autocapitalize="none"
              spellcheck={false}
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              required
            />
          </div>

          <div class={styles.field}>
            <label class={styles.label} for="new-display-name">
              {t('users.displayName')}
            </label>
            <input
              id="new-display-name"
              class={styles.input}
              type="text"
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
            />
          </div>

          <PasswordFields onChange={setPassword} newLabel={t('users.password')} />

          <div class={styles.field}>
            <label class={styles.label} for="new-role">
              {t('users.role')}
            </label>
            <select
              id="new-role"
              class={styles.select}
              value={role()}
              onChange={(e) => setRole(e.currentTarget.value as Role)}
            >
              <option value="member">{t('users.roleMember')}</option>
              <option value="admin">{t('users.roleAdmin')}</option>
            </select>
          </div>

          <Show when={error()}>
            <p class={styles.error} role="alert">
              {error()}
            </p>
          </Show>

          <Button type="submit" disabled={busy()}>
            {t('users.add')}
          </Button>
        </form>

        <Button variant="ghost" onClick={() => navigate('/settings')}>
          {t('common.back')}
        </Button>
      </Show>
    </section>
  );
}
