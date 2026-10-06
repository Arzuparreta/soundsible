import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import type { Device, RemoteCommand } from '../lib/api';
import { nativeDevices, type NativeDeviceState } from './devices';
import { t } from '../lib/i18n';
import styles from '../components/DeviceSheet.module.css';

/** Account HTTP transport and service identity; importing web playback would create another device. */
export default function NativeDevices(props: { generation: () => number; current: () => boolean }) {
  const [devices, setDevices] = createSignal<Device[]>([]), [self, setSelf] = createSignal<NativeDeviceState | null>(null);
  const [loading, setLoading] = createSignal(true), [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false);
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
      if (current()) { setDevices(result.devices ?? []); setError(false); }
    } catch { if (current()) setError(true); }
    finally { refreshing = false; if (current()) setLoading(false); }
  }
  async function command(device: Device, command: RemoteCommand) {
    if (!current() || busy() || device.device_id === self()?.device_id) return;
    setBusy(true); setError(false);
    try {
      await request('/api/playback/remote-command', { method: 'POST', body: { device_id: device.device_id, command }, signal: abort.signal });
      if (current()) await refresh();
    } catch { if (current()) setError(true); }
    finally { if (current()) setBusy(false); }
  }
  onMount(() => {
    void nativeDevices.deviceState().then(accept).catch(() => { if (current()) setError(true); });
    void nativeDevices.addListener('nativeDeviceState', accept).then(handle => { if (alive) listener = handle; else void handle.remove(); }).catch(() => { if (current()) setError(true); });
    void refresh(); timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10000);
  });
  onCleanup(() => { alive = false; abort.abort(); window.clearInterval(timer); void listener?.remove(); });
  return <section data-testid="android-settings-devices">
    <Show when={error()}><p role="status">{t('deviceSheet.failed')}</p></Show>
    <button disabled={!current() || busy()} onClick={() => void refresh()}>{t('android.refresh')}</button>
    <Show when={!loading()}><Show when={devices().length} fallback={<p>{t('deviceSheet.empty')}</p>}>
      <For each={devices()}>{device => <div class={styles.deviceRow}>
        <span class={styles.itemName}>{device.device_name ?? device.device_id}
          <Show when={device.device_id === self()?.device_id}><span class={styles.self}>{t('deviceSheet.selfSuffix')}</span></Show>
        </span>
        <Show when={device.socket_active}><span class={styles.dot} aria-label={t('deviceSheet.ariaOnline')} /></Show>
        <Show when={self()?.device_id && device.device_id !== self()?.device_id}><div class={styles.controls}>
          <For each={['previous', 'pause', 'play', 'next'] as const}>{action => <button type="button" class={styles.ctrl}
            disabled={!current() || busy() || !device.socket_active} aria-label={t(`deviceSheet.aria${action === 'previous' ? 'Prev' : action[0].toUpperCase() + action.slice(1)}` as Parameters<typeof t>[0])}
            onClick={() => void command(device, action)}>{action === 'previous' ? '⏮' : action === 'pause' ? '⏸' : action === 'play' ? '▶' : '⏭'}</button>}</For>
        </div></Show>
      </div>}</For>
    </Show></Show>
  </section>;
}
