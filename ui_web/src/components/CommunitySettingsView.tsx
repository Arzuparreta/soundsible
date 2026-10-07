import { Show } from 'solid-js';
import type { CommunityConfig } from '../lib/community';
import { t } from '../lib/i18n';
import { ActionRow, SettingsGroup, ValueRow } from './SettingsRows';
import styles from './SettingsSections.module.css';

/** Which community relay this server uses and whether it answers; read-only. */
export function CommunitySettingsView(props: { config: CommunityConfig | null; loading: boolean; disabled?: boolean; onRetry: () => void }) {
  const source = () => props.config ? t(`settings.communitySource.${props.config.source}`) : t('common.loading');
  const status = () => props.config ? t(`settings.communityState.${props.config.state}`)
    : props.loading ? t('common.loading') : t('settings.communityState.unavailable');
  return <SettingsGroup note={t('settings.note.community')}>
    <ValueRow anchor="community-service" label={t('settings.communityService')} value={source()} />
    <ValueRow anchor="community-status" label={t('settings.communityStatus')} value={status()} />
    <Show when={props.config?.source === 'custom' && props.config.api_url}>
      <ValueRow label={t('settings.communityRelay')} value={<span class={styles.mono}>{props.config!.api_url}</span>} />
    </Show>
    <Show when={!props.loading && (!props.config || props.config.state === 'unavailable')}>
      <ActionRow label={t('common.retry')} onClick={props.onRetry} disabled={props.disabled} />
    </Show>
  </SettingsGroup>;
}
