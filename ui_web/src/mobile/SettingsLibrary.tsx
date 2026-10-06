import { LibrarySettingsView } from '../components/LibrarySettingsView';
import { ActionRow } from '../components/SettingsRows';
import { createNativeLibraryMaintenance } from './librarySettings';
import { t } from '../lib/i18n';

export default function NativeSettingsLibrary(props: {
  identity: () => number; available: () => boolean; signal: AbortSignal; admin: boolean;
  trackCount: () => number; sync: () => Promise<void>; onImport: () => void;
}) {
  const maintenance = createNativeLibraryMaintenance(props);
  return <section data-testid="android-settings-library" aria-busy={maintenance.busy()}>
    <h2>{t('settings.libraryCard')}</h2>
    <LibrarySettingsView trackCount={props.trackCount()} admin={props.admin} busy={maintenance.busy()} disabled={maintenance.busy() || !props.available()}
      importRow={<ActionRow anchor="import" label={t('settings.importFrom')} hint={t('settings.importNote')} disabled={!props.available()} onClick={props.onImport} />}
      onReload={() => void maintenance.reload()} onRescan={() => void maintenance.rescan()} onCloudSync={() => void maintenance.cloudSync()}
      onRepair={() => void maintenance.repair()} onPurge={() => void maintenance.purge()} onWipe={() => void maintenance.wipe()} />
  </section>;
}
