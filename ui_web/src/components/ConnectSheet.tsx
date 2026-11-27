import { createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { ArtworkSurface } from '../design/Artwork';
import { Control } from '../design/Control';
import type { Device } from '../lib/api';
import { t } from '../lib/i18n';
import { trackCoverUrl } from '../lib/media';
import { openOverlay } from '../lib/overlay';
import { deviceName, isControllable, isOnline, type RemoteControl } from '../lib/remoteControl';
import type { Track } from '../types/music';
import Button from './Button';
import styles from './ConnectSheet.module.css';
import { deviceIcon } from './deviceIcon';
import { EmptyState } from './EmptyState';
import { CheckIcon } from './icons';
import { SkeletonSurfaceRows } from '../design/SkeletonSurfaceRows';

/** This device as the sheet shows it. */
export interface ConnectSelf {
  readonly name: string;
  readonly formFactor?: string;
  readonly deviceType?: string;
  track(): Track | null;
  playing(): boolean;
  playCopy(track: Track, positionSec: number): boolean | Promise<boolean>;
}

function Row(props: {
  selected: boolean;
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
  const selected = () => props.selected;
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
 * controls it; the trailing action copies a track or moves a session. The web
 * player and the Android app open it with their own controller and device. */
export function openConnectSheet(control: RemoteControl, self: ConnectSelf): void {
  const { controlledName, devices: remoteDevices, devicesFailed: remoteDevicesFailed, refreshDevices, retryTarget, selectTarget, target: remoteTarget,
    transferTo, trackCopy, deviceRow, unreachable: remoteUnreachable } = control;
  const selfId = () => control.host.selfId();
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
        (remoteDevices() ?? []).filter((d) => d.device_id !== selfId() && isOnline(d)),
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
      async function copy(id: string): Promise<boolean> {
        const source = trackCopy(id);
        if (!source || !await self.playCopy(source.track, source.positionSec)) return false;
        selectTarget(null);
        return true;
      }
      function deviceAction(d: Device) {
        const local = selfId();
        if (!local) return null;
        const source = d.playing;
        if (source?.track) {
          if (source.mode === 'dj') {
            return { label: t('deviceSheet.moveDjHere'), run: () => transferTo(d.device_id, local) };
          }
          if (source.track.unavailable) return null;
          return { label: t('deviceSheet.copyTrack'), run: () => copy(d.device_id) };
        }
        if (!self.track()) return null;
        return { label: t('deviceSheet.moveHere'), run: () => transferTo(local, d.device_id) };
      }
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
              selected={remoteTarget() === null}
              id={null}
              name={self.name}
              icon={deviceIcon(self.formFactor, self.deviceType)}
              badge={t('settings.group.thisDevice')}
              track={self.track()}
              playing={self.playing()}
              tabStop={!listed()}
              onSelect={() => control(null)}
            />
            <Show when={remoteDevices()} fallback={
              <Show when={remoteDevicesFailed()} fallback={<SkeletonSurfaceRows coverClass={styles.icon} rowClass={styles.row} count={2} variant="device" />}>
                <EmptyState compact tone="danger">
                  {t('common.loadFailed')} <Button variant="secondary" onClick={() => void refreshDevices()}>{t('common.retry')}</Button>
                </EmptyState>
              </Show>
            }>
              <For each={others().map(d => d.device_id)} fallback={<EmptyState compact>{t('deviceSheet.emptyOnline')}</EmptyState>}>
                {(id) => (
                  <Show when={deviceRow(id)}>
                    {(d) => (
                      <Show when={isControllable(d())} fallback={
                        <div class={`${styles.row} ${styles.outdated}`} role="radio" aria-checked="false" aria-disabled="true"
                          data-device-outdated={d().device_id}>
                          <span class={styles.icon}>{deviceIcon(d().form_factor, d().device_type)}</span>
                          <span class={styles.body}>
                            <span class={styles.ellipsis}>{deviceName(d())}</span>
                            <span class={styles.song}>{t('deviceSheet.updateToControl')}</span>
                          </span>
                        </div>
                      }>
                        <div class={styles.entry}>
                          <Row
                            selected={remoteTarget() === d().device_id}
                            id={d().device_id}
                            name={deviceName(d())}
                            icon={deviceIcon(d().form_factor, d().device_type)}
                            badge={d().playing?.mode === 'dj' ? t('autoMode.label') : undefined}
                            track={d().playing?.track}
                            playing={d().playing?.is_playing}
                            tabStop={remoteTarget() === d().device_id}
                            onSelect={() => control(d().device_id)}
                          />
                          <Show when={deviceAction(d())}>
                            {(action) => (
                              <Button variant="ghost" size="sm" class={styles.entryAction} disabled={busy()} aria-busy={busy()}
                                onClick={() => void run(action().run)}>
                                {action().label}
                              </Button>
                            )}
                          </Show>
                        </div>
                      </Show>
                    )}
                  </Show>
                )}
              </For>
            </Show>
          </div>
          <p class={styles.tvHint}>{t('settings.tvConnectHint')}</p>
        </div>
      );
    },
    { ariaLabel: () => t('settings.devices') },
  );
}
