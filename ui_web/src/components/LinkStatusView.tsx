import { t } from '../lib/i18n';
import type { LinkReading } from '../lib/linkQuality';
import { SettingsGroup, ValueRow } from './SettingsRows';

/** Reports the engine's measurement, never an inferred Android connection speed. */
export function LinkStatusView(props: { reading: LinkReading | null }) {
  const value = () => {
    const reading = props.reading;
    const where = reading?.scope ? t(`settings.link.scope.${reading.scope}`) : t('settings.link.scopeUnknown');
    return reading?.kbps ? t('settings.link.measured', { where, mbps: (reading.kbps / 1000).toFixed(1) }) : t('settings.link.notMeasured', { where });
  };
  return <SettingsGroup label={t('settings.group.connection')}>
    <ValueRow anchor="delivery" label={t('settings.link.label')} hint={t('settings.note.connection')} value={value()} />
  </SettingsGroup>;
}
