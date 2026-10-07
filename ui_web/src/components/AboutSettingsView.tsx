import type { JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { SettingRow, SettingsGroup, ValueRow } from './SettingsRows';
import styles from './SettingsSections.module.css';

/** Connection state and what is running; the client decides which builds it can name. */
export function AboutSettingsView(props: { online: boolean; version: JSX.Element; children?: JSX.Element }) {
  return <SettingsGroup>
    <SettingRow anchor="engine-status" label={t('settings.engineLabel')}>
      <span class={styles.status}>
        <span class={styles.statusDot} classList={{ [styles.statusOn]: props.online, [styles.statusOff]: !props.online }} aria-hidden="true" />
        {props.online ? t('common.online') : t('common.offline')}
      </span>
    </SettingRow>
    <ValueRow anchor="version" label={t('brand.soundsible')} value={props.version} />
    {props.children}
  </SettingsGroup>;
}
