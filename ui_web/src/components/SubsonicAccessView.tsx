import { Show } from 'solid-js';
import type { SubsonicAccess } from '../lib/api';
import { t } from '../lib/i18n';
import { ActionRow, SettingRow, SettingsGroup, ValueRow } from './SettingsRows';
import styles from './SettingsSections.module.css';

/** Pure presentation; the client supplies the actual engine URL and credential lifetime. */
export function SubsonicAccessView(props: { access: SubsonicAccess | null; password: string; busy: boolean; unavailable?: boolean;
  serverUrl: string; onGenerate: () => void; onRevoke: () => void; onCopyServer: () => void; onCopyPassword: () => void }) {
  return (
    <>
      <SettingsGroup note={t('subsonic.note')}>
        <ValueRow
          anchor="subsonic-server"
          label={t('subsonic.server')}
          value={<span class={styles.mono}>{props.serverUrl}</span>}
        />
        <ValueRow
          anchor="subsonic-username"
          label={t('subsonic.username')}
          value={<span class={styles.mono}>{props.access?.username ?? '—'}</span>}
        />
        <ActionRow
          anchor="subsonic-copy-server"
          label={t('subsonic.copyServer')}
          onClick={props.onCopyServer} disabled={props.unavailable}
        />
      </SettingsGroup>

      <SettingsGroup
        anchor="subsonic-password"
        label={t('subsonic.password')}
        note={t('subsonic.passwordNote')}
      >
        <Show when={props.password}>
          <SettingRow
            label={t('subsonic.passwordShownOnce')}
            hint={t('subsonic.passwordShownOnceHint')}
          >
            <span data-subsonic-secret class={styles.secret}>{props.password}</span>
          </SettingRow>
          <ActionRow label={t('subsonic.copyPassword')} onClick={props.onCopyPassword} disabled={props.unavailable} />
        </Show>
        <ActionRow
          label={props.access?.configured ? t('subsonic.regenerate') : t('subsonic.generate')}
          hint={props.access?.configured ? t('subsonic.regenerateHint') : t('subsonic.generateHint')}
          onClick={props.onGenerate}
          disabled={props.busy || props.unavailable}
        />
        <Show when={props.access?.configured}>
          <ActionRow
            label={t('subsonic.revoke')}
            hint={t('subsonic.revokeHint')}
            onClick={props.onRevoke}
            disabled={props.busy || props.unavailable}
            danger
          />
        </Show>
      </SettingsGroup>

      <Show when={props.access?.configured}>
        <SettingsGroup label={t('subsonic.usage')}>
          <ValueRow
            label={t('subsonic.lastUsed')}
            value={props.access?.last_used_at ?? t('subsonic.never')}
          />
          <Show when={props.access?.last_client}>
            <ValueRow label={t('subsonic.lastClient')} value={props.access!.last_client!} />
          </Show>
        </SettingsGroup>
      </Show>
    </>
  );
}
