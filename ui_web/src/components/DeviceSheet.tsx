import { createSignal, For, Show, onMount, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { api, type Device } from '../lib/api';
import { state } from '../stores';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './DeviceSheet.module.css';
import { EmptyState } from './EmptyState';
import { SkeletonRows } from './Skeleton';
import Button from './Button';
import { createResponsiveTap } from '../lib/responsiveTap';
import { remoteCommandMessage, remotePlayTracksArgs } from '../lib/remotePlayback';
import { player } from '../stores/player';

const others = (devs: Device[]): Device[] => devs.filter((d) => d.device_id !== state.device.device_id);
const deviceName = (d: Device): string => d.device_name ?? t('deviceSheet.fallbackDevice');
const isOnline = (d: Device): boolean => Boolean(d.online ?? d.socket_active);

export function deviceIcon(formFactor?: string, type?: string): JSX.Element {
  if (formFactor === 'computer' || (!formFactor && type === 'desktop'))
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    );
  if (formFactor === 'tablet')
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <path d="M11 18h2" />
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
      const name = deviceName(d);
      const h = toast.loading(t('deviceSheet.sendingTo', { device: name }));
      try {
        const answer = await api.deviceCommand(d.device_id, 'play.tracks', remotePlayTracksArgs(track));
        if (answer.status === 'applied') h.update('success', t('deviceSheet.playingOn'));
        else h.update('error', remoteCommandMessage(answer, name));
      } catch {
        h.update('error', remoteCommandMessage(null, name));
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
                    <span class={styles.icon}>{deviceIcon(d.form_factor, d.device_type)}</span>
                    <span class={styles.itemName}>{d.device_name ?? d.device_id}</span>
                    <Show when={isOnline(d)}>
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

/** The device sheet (control another device, move the music) is loaded on use. */
export const openConnect = () => void import('./ConnectSheet').then((m) => m.openConnectSheet());

/** What a device button says: the controlled device, or where devices are. */
export const connectLabel = () =>
  !player().remote ? t('settings.devices')
    : t(player().unreachable ? 'deviceSheet.offline' : 'deviceSheet.playingOnDevice', { device: player().deviceName });
