import { createSignal, onMount, onCleanup } from 'solid-js';
import { nativeDevices, type NativeDeviceState } from './devices';
import { t } from '../lib/i18n';
import { promptDialog } from '../lib/prompt';
import { PairedDevicesPanel } from '../components/PairDevice';
import { ActionRow, SettingsGroup } from '../components/SettingsRows';

/** This phone's name and pairing. Choosing which device plays, and moving the
 * music, is the device sheet's job (the Devices button above the player). */
export default function NativeDevices(props: { generation: () => number; current: () => boolean; origin?: () => string }) {
  const [self, setSelf] = createSignal<NativeDeviceState | null>(null);
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal<string | null>(null);
  const generation = props.generation();
  let alive = true, listener: { remove(): Promise<void> } | undefined;
  const current = () => alive && props.current() && props.generation() === generation;
  const accept = (state: NativeDeviceState) => { if (current() && state.generation === generation) setSelf(state); };
  async function rename() {
    const previous = self()?.device_name;
    if (!current() || busy() || !previous) return;
    const name = await promptDialog({ title: t('settings.deviceName'), message: t('settings.note.device'), inputLabel: t('settings.deviceName'),
      initial: previous, confirmLabel: t('common.save') }, current);
    if (!name?.trim() || name.trim() === previous || !current()) return;
    setBusy(true); setError(null);
    try { accept(await nativeDevices.deviceRename({ generation, name: name.trim() })); }
    catch { if (current()) setError(t('common.loadFailed')); }
    finally { if (current()) setBusy(false); }
  }
  onMount(() => {
    void nativeDevices.deviceState().then(accept).catch(() => { if (current()) setError(t('common.loadFailed')); });
    void nativeDevices.addListener('nativeDeviceState', accept).then(handle => { if (alive) listener = handle; else void handle.remove(); }).catch(() => { if (current()) setError(t('common.loadFailed')); });
  });
  onCleanup(() => { alive = false; void listener?.remove(); });
  return <section data-testid="android-settings-devices">
    <SettingsGroup label={t('settings.group.thisDevice')}>
      <ActionRow anchor="device-name" label={t('settings.deviceName')} hint={self()?.device_name} disabled={!current() || busy() || !self()?.device_name} onClick={() => void rename()} />
    </SettingsGroup>
    {error() && <p role="status">{error()}</p>}
    <SettingsGroup anchor="paired-devices" label={t('settings.pairedDevices')} note={t('settings.pairNote')}>
      <PairedDevicesPanel origin={() => props.origin?.() || null} />
    </SettingsGroup>
  </section>;
}
