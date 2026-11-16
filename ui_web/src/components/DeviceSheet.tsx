import { createSignal, For, Show, onMount, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { api, type Device, type RemoteCommand } from '../lib/api';
import { state } from '../stores';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './DeviceSheet.module.css';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';
import Button from './Button';
import { createResponsiveTap } from '../lib/responsiveTap';
import { remotePlayRequest } from '../lib/remotePlayback';

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

/** One read of the device list. A failed read is its own state: an empty list
 * would say "no other devices" about devices nobody managed to ask for. */
function createDeviceList(select: (devices: Device[]) => Device[]) {
  const [devs, setDevs] = createSignal<Device[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const d = await api.listDevices();
      setDevs(select(d.devices ?? []));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  onMount(load);
  return { devs, loading, failed, load };
}

function DeviceListState(props: { list: ReturnType<typeof createDeviceList>; empty: string; children: JSX.Element }) {
  return (
    <Show when={!props.list.loading()} fallback={<SkeletonRows count={3} compact />}>
      <Show
        when={!props.list.failed()}
        fallback={
          <EmptyState compact tone="danger">
            {t('common.loadFailed')} <Button variant="secondary" onClick={() => void props.list.load()}>{t('common.retry')}</Button>
          </EmptyState>
        }
      >
        <Show when={props.list.devs().length > 0} fallback={<EmptyState compact>{props.empty}</EmptyState>}>
          {props.children}
        </Show>
      </Show>
    </Show>
  );
}

/** Pick a device to resolve and play this element on. */
export function openPlayOnDevice(track: Track): void {
  openOverlay((close) => {
    const list = createDeviceList(others);
    const play = async (d: Device) => {
      close();
      const h = toast.loading(t('deviceSheet.sendingTo', { device: d.device_name ?? t('deviceSheet.fallbackDevice') }));
      try {
        await api.remoteCommand(d.device_id, 'play', remotePlayRequest(track));
        h.update('success', t('deviceSheet.playingOn'));
      } catch {
        h.update('error', t('deviceSheet.failed'));
      }
    };
    return (
      <div class={styles.sheet}>
        <header class={styles.head}>
          <span class={styles.title}>{t('deviceSheet.title')}</span>
        </header>
        <DeviceListState list={list} empty={t('deviceSheet.emptyOthers')}>
            <For each={list.devs()}>
              {(d) => {
                const tap = createResponsiveTap({ onTap: () => void play(d) });
                return (
                  <button class={styles.item} type="button" data-pressable {...tap}>
                    <span class={styles.icon}>{deviceIcon(d.device_type)}</span>
                    <span class={styles.itemName}>{d.device_name ?? d.device_id}</span>
                    <Show when={d.socket_active}>
                      <span class={styles.dot} aria-label={t('deviceSheet.ariaOnline')} />
                    </Show>
                  </button>
                );
              }}
            </For>
        </DeviceListState>
      </div>
    );
  });
}

/** Settings panel: list devices with transport controls for each. */
export function DevicesPanel() {
  const list = createDeviceList((devices) => devices);

  const cmd = async (d: Device, command: RemoteCommand) => {
    try {
      await api.remoteCommand(d.device_id, command);
    } catch {
      toast.error(t('deviceSheet.failed'));
    }
  };

  return (
    <DeviceListState list={list} empty={t('deviceSheet.empty')}>
        <For each={list.devs()}>
          {(d) => (
            <div class={styles.deviceRow}>
              <span class={styles.icon}>{deviceIcon(d.device_type)}</span>
              <span class={styles.itemName}>
                {d.device_name ?? d.device_id}
                <Show when={d.device_id === state.device.device_id}>
                  <span class={styles.self}>{t('deviceSheet.selfSuffix')}</span>
                </Show>
              </span>
              <Show when={d.device_id !== state.device.device_id}>
                <div class={styles.controls}>
                  <button class={styles.ctrl} type="button" aria-label={t('deviceSheet.ariaPrev')} onClick={() => cmd(d, 'previous')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label={t('deviceSheet.ariaPause')} onClick={() => cmd(d, 'pause')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label={t('deviceSheet.ariaPlay')} onClick={() => cmd(d, 'play')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>
                  </button>
                  <button class={styles.ctrl} type="button" aria-label={t('deviceSheet.ariaNext')} onClick={() => cmd(d, 'next')}>
                    <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
    </DeviceListState>
  );
}
