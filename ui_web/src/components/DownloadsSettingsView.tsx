import { t } from '../lib/i18n';
import { SegmentedRow, SettingsGroup, SwitchRow } from './SettingsRows';

export const DOWNLOAD_QUALITIES = ['low', 'normal', 'high'] as const;
export type DownloadQuality = (typeof DOWNLOAD_QUALITIES)[number];
export interface DownloaderSettings { quality: DownloadQuality; autoUpdateYtdlp: boolean; autoUpdateCurlCffi: boolean }

function qualityLabel(quality: DownloadQuality): string {
  if (quality === 'low') return t('settings.qualityLow');
  if (quality === 'normal') return t('settings.qualityNormal');
  return t('settings.qualityHigh');
}

/** Instance downloader preferences; values come only from a confirmed read. */
export function DownloadsSettingsView(props: DownloaderSettings & {
  disabled?: boolean; onQuality: (quality: DownloadQuality) => void; onToggleYtdlp: () => void; onToggleCurlCffi: () => void;
}) {
  return <>
    <SettingsGroup>
      <SegmentedRow anchor="quality" label={t('settings.quality')} hint={t('settings.note.quality')}
        options={DOWNLOAD_QUALITIES.map(value => ({ value, label: qualityLabel(value) }))} disabled={props.disabled}
        value={props.quality} onChange={props.onQuality} />
    </SettingsGroup>
    <SettingsGroup label={t('settings.group.updates')} note={t('settings.note.updates')}>
      <SwitchRow anchor="auto-update-ytdlp" label={t('settings.autoUpdateYtdlp')} checked={props.autoUpdateYtdlp} disabled={props.disabled} onChange={props.onToggleYtdlp} />
      <SwitchRow anchor="auto-update-curl-cffi" label={t('settings.autoUpdateCurlCffi')} checked={props.autoUpdateCurlCffi} disabled={props.disabled} onChange={props.onToggleCurlCffi} />
    </SettingsGroup>
  </>;
}
