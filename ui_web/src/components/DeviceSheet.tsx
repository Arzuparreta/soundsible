import { createSignal, For, Show, onMount, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { api, type Device, type RemoteCommand } from '../lib/api';
import { state } from '../stores';
import { toast } from '../lib/toast';
import type { Track } from '../types/music';
import styles from './DeviceSheet.module.css';

const others = (devs: Device[]): Device[] => devs.filter((d) => d.device_id !== state.device.device_id);

function deviceIcon(type?: string): JSX.Element {
  if (type === 'desktop')
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}

/** Pick a device to play a (library) track on. */
export function openPlayOnDevice(track: Track): void {
  openOverlay((close) => {
    const [devs, setDevs] = createSignal<Device[]>([]);
    const [loading, setLoading] = createSignal(true);
    onMount(async () => {
      try {
        const d = await api.listDevices();
        setDevs(others(d.devices ?? []));
      } catch {
        /* leave empty */
      } finally {
        setLoading(false);
      }
    });
    const play = async (d: Device) => {
      close();
      const t = toast.loading(`Enviando a ${d.device_name ?? 'dispositivo'}…`);
      try {
        await api.remoteCommand(d.device_id, 'play', { track_id: track.id });
        t.update('success', 'Reproduciendo en el dispositivo');
      } catch {
        t.update('error', 'No se pudo controlar el dispositivo');
      }
    };
    return (
      <div class={styles.sheet}>
        <header class={styles.head}>
          <span class={styles.title}>Reproducir en…</span>
        </header>
        <Show when={!loading()} fallback={<p class={styles.empty}>Buscando dispositivos…</p>}>
          <Show when={devs().length > 0} fallback={<p class={styles.empty}>No hay otros dispositivos conectados.</p>}>
            <For each={devs()}>
              {(d) => (
                <button class={styles.item} type="button" onClick={() => play(d)}>
                  <span class={styles.icon}>{deviceIcon(d.device_type)}</span>
                  <span class={styles.itemName}>{d.device_name ?? d.device_id}</span>
                  <Show when={d.socket_active}>
                    <span class={styles.dot} aria-label="En línea" />
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>
    );
  });
}

/** Settings panel: list devices with transport controls for each. */
export function DevicesPanel() {
  const [devs, setDevs] = createSignal<Device[]>([]);
  const [loading, setLoading] = createSignal(true);
  const refresh = async () => {
    try {
      const d = await api.listDevices();
      setDevs(d.devices ?? []);
    } catch {
      /* leave */
    } finally {
      setLoading(false);
    }
  };
  onMount(refresh);

  const cmd = async (d: Device, command: RemoteCommand) => {
    try {
      await api.remoteCommand(d.device_id, command);
    } catch {
      toast.error('No se pudo controlar el dispositivo');
    }
  };

  return (
    <Show when={!loading()} fallback={<p class={styles.empty}>Buscando…</p>}>
      <Show when={devs().length > 0} fallback={<p class={styles.empty}>No hay dispositivos conectados.</p>}>
        <For each={devs()}>
          {(d) => (
            <div class={styles.deviceRow}>
              <span class={styles.icon}>{deviceIcon(d.device_type)}</span>
              <span class={styles.itemName}>
                {d.device_name ?? d.device_id}
                <Show when={d.device_id === state.device.device_id}>
                  <span class={styles.self}> (este)</span>
                </Show>
              </span>
              <Show when={d.device_id !== state.device.device_id}>
                <div class={styles.controls}>
                  <button class={styles.ctrl} type="button" aria-label="Anterior" onClick={() => cmd(d, 'previous')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label="Pausar" onClick={() => cmd(d, 'pause')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label="Reproducir" onClick={() => cmd(d, 'play')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label="Siguiente" onClick={() => cmd(d, 'next')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </Show>
  );
}
