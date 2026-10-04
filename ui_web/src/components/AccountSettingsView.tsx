import { Show } from 'solid-js';
import { t } from '../lib/i18n';
import type { User } from '../lib/session';
import { ActionRow, SettingsGroup, SwitchRow } from './SettingsRows';
import styles from './SettingsSections.module.css';

/** Account rows shared by web and native transports; no playback/session store. */
export function AccountSettingsView(props: {
  user: User | null; disabled?: boolean; pending?: boolean; historyEnabled: boolean;
  onName: () => void; onUsername: () => void; onPassword: () => void;
  onLogout: () => void; onHistoryChange: () => void;
}) {
  return (
    <Show when={props.user}>
      {(me) => (
        <>
          <div class={styles.identity}>
            <span
              class={styles.avatar}
              style={{ background: me().avatar_color ?? 'var(--accent)' }}
              aria-hidden="true"
            >
              {(me().display_name || me().username).trim().slice(0, 1)}
            </span>
            <span class={styles.identityText}>
              <span class={styles.identityName}>{me().display_name}</span>
              <span class={styles.identityHandle}>@{me().username}</span>
            </span>
          </div>

          <SettingsGroup label={t('settings.group.profile')}>
            <ActionRow anchor="change-name" label={t('account.changeName')} disabled={props.disabled} onClick={props.onName} />
            <ActionRow
              anchor="change-username"
              label={t('account.changeUsername')}
              hint={t('account.usernameHint')}
              disabled={props.disabled} onClick={props.onUsername}
            />
            <ActionRow
              anchor="change-password"
              label={t('account.changePassword')}
              hint={me().has_password ? undefined : t('settings.note.noPassword')}
              disabled={props.disabled} onClick={props.onPassword}
            />
          </SettingsGroup>

          <SettingsGroup label={t('settings.group.searchHistory')}>
            <SwitchRow
              anchor="search-history"
              label={t('settings.searchHistory')}
              hint={t('settings.note.searchHistory')}
              checked={props.historyEnabled}
              onChange={props.onHistoryChange}
            />
          </SettingsGroup>

          <SettingsGroup>
            <ActionRow anchor="sign-out" label={t('account.signOut')} disabled={props.pending} onClick={props.onLogout} danger />
          </SettingsGroup>
        </>
      )}
    </Show>
  );
}
