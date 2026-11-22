import { createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { ArtworkSurface } from '../design/Artwork';
import { Control } from '../design/Control';
import type { Device } from '../lib/api';
import { t } from '../lib/i18n';
import { trackCoverUrl } from '../lib/media';
import { openOverlay } from '../lib/overlay';
import { state } from '../stores';
import {
  controlledName,
  deviceName,
  isControllable,
  isOnline,
  refreshDevices,
  remoteDevices,
  remoteDevicesFailed,
  remoteTarget,
  remoteUnreachable,
  retryTarget,
  selectTarget,
  transferTo,
} from '../stores/remote';
import type { Track } from '../types/music';
import Button from './Button';
import styles from './ConnectSheet.module.css';
import { deviceIcon } from './DeviceSheet';
import { EmptyState } from './EmptyState';
import { CheckIcon } from './icons';
import { SkeletonRows } from './Skeleton';

function Row(props: {
  id: string | null;
  name: string;
  icon: JSX.Element;
  badge?: string;
  track?: Track | null;
  playing?: boolean;
  /** The group's one tab stop: the checked radio, or this device when the checked one is not listed. */
  tabStop: boolean;
  onSelect: () => void;
}) {
  const selected = () => remoteTarget() === props.id;
  return (
    <Control
      class={styles.row}
      role="radio"
      aria-checked={selected()}
      tabIndex={props.tabStop ? 0 : -1}
      data-device-row={props.id ?? 'local'}
      onClick={props.onSelect}
    >
      <span class={styles.icon}>{props.icon}</span>
      <span class={styles.body}>
        <span class={styles.name}>
          <span class={styles.ellipsis}>{props.name}</span>
          <Show when={props.badge}>{(badge) => <span class={styles.badge}>{badge()}</span>}</Show>
          <Show when={props.track}>
            <span class={styles.state}>{props.playing ? t('nowPlaying.playing') : t('musicList.paused')}</span>
          </Show>
        </span>
        <Show when={props.track}>
          {(track) => (
            <span class={styles.song}>
              <ArtworkSurface class={styles.cover} seed={track().id} src={trackCoverUrl(track(), 'thumb')} />
              <span class={styles.ellipsis}>{track().title} · {track().artist}</span>
            </span>
          )}
        </Show>
      </span>
      <Show when={selected()}>
        <span class={styles.check} aria-hidden="true"><CheckIcon size={18} /></span>
      </Show>
    </Control>
  );
}

/** Radios move with the arrow keys; Tab leaves the group (one tab stop). */
const moveFocus: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled])')];
  const from = radios.indexOf(document.activeElement as HTMLElement);
  if (from < 0) return;
  event.preventDefault();
  radios[(from + step + radios.length) % radios.length].focus();
};

/** Which device plays and which one this player controls. Tapping a device
 * controls it; moving the music is the explicit, secondary action. */
export function openConnectSheet(): void {
  openOverlay(
    (close) => {
      const [busy, setBusy] = createSignal(false);
      let list!: HTMLDivElement;
      onMount(() => {
        void refreshDevices();
        // A radio group is entered on its checked radio. The overlay focuses its
        // first control first; the offline banner's buttons keep that focus.
        setTimeout(() => {
          if (!remoteUnreachable()) list.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
        });
      });
      const others = createMemo(() =>
        (remoteDevices() ?? []).filter((d) => d.device_id !== state.device.device_id && isOnline(d)),
      );
      const control = (id: string | null) => {
        selectTarget(id);
        close();
      };
      const listed = () => others().some((d) => d.device_id === remoteTarget() && isControllable(d));
      const run = async (task: () => Promise<boolean>) => {
        setBusy(true);
        const done = await task();
        setBusy(false);
        if (done) close();
      };
      // One transfer button, and only when its direction is unambiguous.
      const transfer = (d: Device) => {
        const here = Boolean(state.playback.currentTrack), there = Boolean(d.playing?.track);
        if (here === there) return null;
        const [from, to] = here ? [state.device.device_id, d.device_id] : [d.device_id, state.device.device_id];
        return { label: t(here ? 'deviceSheet.moveHere' : 'deviceSheet.listenHere'), run: () => transferTo(from, to) };
      };
      return (
        <div class={styles.sheet} data-connect-sheet="">
          <h2 class={styles.title}>{t('settings.devices')}</h2>
          <Show when={remoteTarget() && remoteUnreachable()}>
            <div class={styles.offline} role="alert">
              <p>{t('deviceSheet.offline', { device: controlledName() })}</p>
              <div class={styles.actions}>
                <Button variant="secondary" size="sm" disabled={busy()} aria-busy={busy()}
                  onClick={() => void run(retryTarget)}>
                  {t('deviceSheet.tryAgain')}
                </Button>
                <Button size="sm" onClick={() => control(null)}>{t('deviceSheet.useThisDevice')}</Button>
              </div>
            </div>
          </Show>
          <div ref={list} class={styles.list} role="radiogroup" aria-label={t('settings.devices')} onKeyDown={moveFocus}>
            <Row
              id={null}
              name={state.device.device_name}
              icon={deviceIcon(state.device.form_factor, state.device.device_type)}
              badge={t('settings.group.thisDevice')}
              track={state.playback.currentTrack}
              playing={state.playback.isPlaying}
              tabStop={!listed()}
              onSelect={() => control(null)}
            />
            <Show when={remoteDevices()} fallback={
              <Show when={remoteDevicesFailed()} fallback={<SkeletonRows count={2} compact />}>
                <EmptyState compact tone="danger">
                  {t('common.loadFailed')} <Button variant="secondary" onClick={() => void refreshDevices()}>{t('common.retry')}</Button>
                </EmptyState>
              </Show>
            }>
              <For each={others()} fallback={<EmptyState compact>{t('deviceSheet.emptyOnline')}</EmptyState>}>
                {(d) => (
                  <Show when={isControllable(d)} fallback={
                    <div class={`${styles.row} ${styles.outdated}`} role="radio" aria-checked="false" aria-disabled="true"
                      data-device-outdated={d.device_id}>
                      <span class={styles.icon}>{deviceIcon(d.form_factor, d.device_type)}</span>
                      <span class={styles.body}>
                        <span class={styles.ellipsis}>{deviceName(d)}</span>
                        <span class={styles.song}>{t('deviceSheet.updateToControl')}</span>
                      </span>
                    </div>
                  }>
                    <div class={styles.entry}>
                      <Row
                        id={d.device_id}
                        name={deviceName(d)}
                        icon={deviceIcon(d.form_factor, d.device_type)}
                        badge={d.playing?.mode === 'dj' ? t('autoMode.label') : undefined}
                        track={d.playing?.track}
                        playing={d.playing?.is_playing}
                        tabStop={remoteTarget() === d.device_id}
                        onSelect={() => control(d.device_id)}
                      />
                      <Show when={transfer(d)}>
                        {(move) => (
                          <Button variant="ghost" size="sm" class={styles.move} disabled={busy()} aria-busy={busy()}
                            onClick={() => void run(move().run)}>
                            {move().label}
                          </Button>
                        )}
                      </Show>
                    </div>
                  </Show>
                )}
              </For>
            </Show>
          </div>
        </div>
      );
    },
    { ariaLabel: () => t('settings.devices') },
  );
}
