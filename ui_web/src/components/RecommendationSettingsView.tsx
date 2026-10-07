import { t } from '../lib/i18n';
import { ActionRow, SettingsGroup, SwitchRow } from './SettingsRows';

/** Preference values and mutations belong to the client's scoped controller. */
export function RecommendationSettingsView(props: { learning: boolean; disabled?: boolean; onToggle: () => void; onReset: () => void }) {
  return <SettingsGroup label={t('settings.group.recommendations')}>
    <SwitchRow anchor="learn-activity" label={t('settings.learnActivity')} hint={t('settings.learnActivityNote')}
      checked={props.learning} disabled={props.disabled} onChange={props.onToggle} />
    <ActionRow anchor="reset-learning" label={t('settings.resetLearning')} disabled={props.disabled} onClick={props.onReset} />
  </SettingsGroup>;
}
