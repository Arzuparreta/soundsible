import { t } from '../lib/i18n';
import { SwitchRow } from './SettingsRows';

/** Both clients keep the same setting; their platform owns the feedback. */
export function HapticSettingsView(props: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return <SwitchRow anchor="haptics" label={t('settings.haptics')} hint={t('settings.note.haptics')}
    checked={props.enabled} onChange={() => props.onChange(!props.enabled)} />;
}
