import { Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { ActionRow, SettingsGroup, ValueRow } from './SettingsRows';

/** Library maintenance rows; each client owns the requests, confirmations and how import is reached. */
export function LibrarySettingsView(props: {
  trackCount: number; admin: boolean; busy?: boolean; disabled?: boolean; importRow: JSX.Element;
  onReload: () => void; onRescan: () => void; onCloudSync: () => void; onRepair: () => void; onPurge: () => void; onWipe: () => void;
}) {
  return <>
    <SettingsGroup>
      <ValueRow anchor="track-count" label={t('settings.tracks')} value={String(props.trackCount)} />
      {props.importRow}
    </SettingsGroup>
    <SettingsGroup label={t('settings.group.sync')} note={t('settings.note.sync')}>
      <ActionRow anchor="reload" label={t('settings.reload')} onClick={props.onReload} disabled={props.busy || props.disabled} />
      <ActionRow anchor="rescan" label={t('settings.rescan')} onClick={props.onRescan} disabled={props.busy || props.disabled} />
      <Show when={props.admin}>
        <ActionRow anchor="cloud-sync" label={t('settings.sync')} onClick={props.onCloudSync} disabled={props.disabled} />
      </Show>
    </SettingsGroup>
    <SettingsGroup label={t('settings.group.maintenance')} note={t('settings.note.maintenance')}>
      <ActionRow anchor="repair" label={t('settings.repair')} onClick={props.onRepair} disabled={props.disabled} />
      <ActionRow anchor="purge-missing" label={t('settings.purgeFiles')} onClick={props.onPurge} disabled={props.disabled} />
      <Show when={props.admin}>
        <ActionRow anchor="empty-library" label={t('settings.emptyLibrary')} onClick={props.onWipe} disabled={props.disabled} danger warn />
      </Show>
    </SettingsGroup>
  </>;
}
