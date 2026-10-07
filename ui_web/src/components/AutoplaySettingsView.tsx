import { t } from '../lib/i18n';
import { SwitchRow } from './SettingsRows';

export function AutoplaySettingsView(props: { enabled: boolean; disabled?: boolean; onChange: () => void }) {
  return <SwitchRow anchor="autoplay" label={t('settings.autoplay')} hint={t('settings.note.autoplay')}
    checked={props.enabled} disabled={props.disabled} onChange={props.onChange} />;
}
