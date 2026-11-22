import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { api, type Device } from '../lib/api';
import { remoteCommandMessage } from '../lib/remotePlayback';
import { nativeDevices, type NativeDeviceState } from './devices';
import { t } from '../lib/i18n';
import { promptDialog } from '../lib/prompt';
import { PairedDevicesPanel } from '../components/PairDevice';
import { ActionRow, SettingsGroup } from '../components/SettingsRows';
import styles from '../components/DeviceSheet.module.css';

type TransportAction = 'previous' | 'pause' | 'play' | 'next';
const isOnline = (device: Device): boolean => Boolean(device.online ?? device.socket_active);

/** Account HTTP transport and service identity; importing web playback would create another device. */
export default function NativeDevices(props: { generation: () => number; current: () => boolean; origin?: () => string }) {
  const [devices, setDevices] = createSignal<Device[]>([]), [self, setSelf] = createSignal<NativeDeviceState | null>(null);
  const [loading, setLoading] = createSignal(true), [busy, setBusy] = createSignal(false), [error, setError] = createSignal<string | null>(null);
  const generation = props.generation();
  let alive = true, refreshing = false, timer: number | undefined, listener: { remove(): Promise<void> } | undefined;
  const abort = new AbortController();
  const current = () => alive && props.current() && props.generation() === generation;
  const accept = (state: NativeDeviceState) => { if (current() && state.generation === generation) setSelf(state); };
  async function refresh() {
    if (!current() || refreshing) return;
    refreshing = true;
    try {
      const result = await request<{ devices?: Device[] }>('/api/devices', { signal: abort.signal });
      if (current()) { setDevices(result.devices ?? []); setError(null); }
    } catch { if (current()) setError(t('common.loadFailed')); }
    finally { refreshing = false; if (current()) setLoading(false); }
  }
  async function command(device: Device, action: TransportAction) {
    if (!current() || busy() || device.device_id === self()?.device_id) return;
    const name = device.device_name ?? t('deviceSheet.fallbackDevice');
    setBusy(true); setError(null);
    try {
      const answer = await api.deviceCommand(device.device_id, `transport.${action}`, {}, { signal: abort.signal });
      if (!current()) return;
      if (answer.status !== 'applied') setError(remoteCommandMessage(answer, name));
      else await refresh();
    } catch { if (current()) setError(remoteCommandMessage(null, name)); }
    finally { if (current()) setBusy(false); }
  }
  async function handoff(device: Device) {
    if (!current() || busy() || !self()?.can_handoff || !isOnline(device) || device.device_id === self()?.device_id) return;
    const name = device.device_name ?? t('deviceSheet.fallbackDevice');
    setBusy(true); setError(null);
    try { accept(await nativeDevices.deviceHandoff({ generation, device_id: device.device_id })); if (current()) await refresh(); }
    catch { if (current()) setError(remoteCommandMessage(null, name)); }
    finally { if (current()) setBusy(false); }
  }
  async function rename() {
    const previous = self()?.device_name;
    if (!current() || busy() || !previous) return;
    const name = await promptDialog({ title: t('settings.deviceName'), message: t('settings.note.device'), inputLabel: t('settings.deviceName'),
      initial: previous, confirmLabel: t('common.save') }, current);
    if (!name?.trim() || name.trim() === previous || !current()) return;
    setBusy(true); setError(null);
    try { accept(await nativeDevices.deviceRename({ generation, name: name.trim() })); if (current()) await refresh(); }
    catch { if (current()) setError(t('common.loadFailed')); }
    finally { if (current()) setBusy(false); }
  }
  onMount(() => {
    void nativeDevices.deviceState().then(accept).catch(() => { if (current()) setError(t('common.loadFailed')); });
    void nativeDevices.addListener('nativeDeviceState', accept).then(handle => { if (alive) listener = handle; else void handle.remove(); }).catch(() => { if (current()) setError(t('common.loadFailed')); });
    void refresh(); timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10000);
  });
  onCleanup(() => { alive = false; abort.abort(); window.clearInterval(timer); void listener?.remove(); });
  return <section data-testid="android-settings-devices">
    <SettingsGroup label={t('settings.group.thisDevice')}>
      <ActionRow anchor="device-name" label={t('settings.deviceName')} hint={self()?.device_name} disabled={!current() || busy() || !self()?.device_name} onClick={() => void rename()} />
    </SettingsGroup>
    <SettingsGroup anchor="paired-devices" label={t('settings.pairedDevices')} note={t('settings.pairNote')}>
      <PairedDevicesPanel origin={() => props.origin?.() || null} />
    </SettingsGroup>
    <h3 data-setting="network-devices">{t('settings.group.network')}</h3>
    <Show when={error()}>{msg => <p role="status">{msg()}</p>}</Show>
    <button disabled={!current() || busy()} onClick={() => void refresh()}>{t('android.refresh')}</button>
    <Show when={!loading()}><Show when={devices().length} fallback={<p>{t('deviceSheet.empty')}</p>}>
      <For each={devices()}>{device => <div class={styles.deviceRow}>
        <span class={styles.itemName}>{device.device_name ?? device.device_id}
          <Show when={device.device_id === self()?.device_id}><span class={styles.self}>{t('deviceSheet.selfSuffix')}</span></Show>
        </span>
        <Show when={isOnline(device)}><span class={styles.dot} aria-label={t('deviceSheet.ariaOnline')} /></Show>
        <Show when={self()?.device_id && device.device_id !== self()?.device_id}><div class={styles.controls}>
          <For each={['previous', 'pause', 'play', 'next'] as const}>{action => <button type="button" class={styles.ctrl}
            disabled={!current() || busy() || !isOnline(device)} aria-label={t(`deviceSheet.aria${action === 'previous' ? 'Prev' : action[0].toUpperCase() + action.slice(1)}` as Parameters<typeof t>[0])}
            onClick={() => void command(device, action)}>{action === 'previous' ? '⏮' : action === 'pause' ? '⏸' : action === 'play' ? '▶' : '⏭'}</button>}</For>
          <button type="button" disabled={!current() || busy() || !isOnline(device) || !self()?.can_handoff}
            onClick={() => void handoff(device)}>{t('deviceSheet.transfer')}</button>
        </div></Show>
      </div>}</For>
    </Show></Show>
  </section>;
}
