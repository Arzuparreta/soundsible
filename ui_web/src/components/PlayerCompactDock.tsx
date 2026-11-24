import { createEffect, createSignal, createUniqueId, onCleanup, Show } from 'solid-js';
import { player } from '../stores/player';
import { t } from '../lib/i18n';
import { playerCompact } from '../lib/playerDock';
import { detectFormFactor } from '../lib/deviceIdentity';
import { Control } from '../design/Control';
import { KaraokeMicIcon, QueueListIcon, RadioIcon, VolumeIcon } from './icons';
import { onStopRadio } from './RadioBadge';
import { VolumeRange } from './VolumeRange';
import styles from './PlayerCompactDock.module.css';

/**
 * Persistent compact bottom bar shared by Stage, Queue/Route and Lyrics (below `PLAYER_COMPACT_BELOW`).
 *
 * View toggles sit on the left; playback utilities sit on the right. On
 * `mobileWeb` phones the volume button is a direct mute toggle; on desktop
 * docked columns hover or keyboard focus opens a slider popover above the
 * button while clicks still toggle mute. The popover lives inline rather than
 * in `openOverlay` because hover intent needs uninterrupted pointer travel
 * between trigger and slider without a full-screen backdrop intercepting it.
 */
export function PlayerCompactDock(props: {
  auto: boolean;
  hasTrack: boolean;
  podcast: boolean;
  lyricsActive: boolean;
  listActive: boolean;
  listCount: number;
  surfaceOpen: boolean;
  onToggleLyrics: () => void;
  onToggleList: () => void;
  lyricsButtonRef?: (element: HTMLButtonElement) => void;
}) {
  const [volumeOpen, setVolumeOpen] = createSignal(false);
  const mobileWeb = detectFormFactor() !== 'computer';
  const volumeId = createUniqueId();
  let volumeRoot: HTMLDivElement | undefined;
  let volumeTrigger: HTMLButtonElement | undefined;
  let volumePopup: HTMLDivElement | undefined;
  let volumeDismissTimer: ReturnType<typeof setTimeout> | undefined;

  const current = () => player().playback.currentTrack;

  const cancelVolumeDismiss = () => clearTimeout(volumeDismissTimer);
  onCleanup(cancelVolumeDismiss);
  const closeVolume = () => {
    cancelVolumeDismiss();
    setVolumeOpen(false);
  };
  const openVolume = () => {
    if (mobileWeb) return;
    cancelVolumeDismiss();
    setVolumeOpen(true);
  };
  const leaveVolume = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    cancelVolumeDismiss();
    volumeDismissTimer = setTimeout(() => {
      if (!volumePopup?.contains(document.activeElement)) closeVolume();
    }, 160);
  };
  createEffect(() => {
    if (!props.surfaceOpen || !playerCompact() || !player().can('transport.set_volume')) setVolumeOpen(false);
  });
  createEffect(() => {
    if (!volumeOpen()) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !volumeRoot?.contains(event.target) && !volumePopup?.contains(event.target)) closeVolume();
    };
    // Escape layer order: OverlayOutlet (window capture) > inline volume popover
    // (document capture while open) > Lyrics (document bubble) > player (window bubble).
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (volumePopup?.contains(document.activeElement)) {
        volumeTrigger?.focus({ preventScroll: true });
      }
      closeVolume();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);
    document.addEventListener('scroll', closeVolume, true);
    document.addEventListener('keydown', onEscape, true);
    window.addEventListener('resize', closeVolume);
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
      document.removeEventListener('scroll', closeVolume, true);
      document.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('resize', closeVolume);
    });
  });

  return (
    <nav
      class={styles.compactDock}
      aria-label={props.auto ? t('autoMode.mobile.controls') : t('nowPlaying.compactControls')}
      data-no-surface-swipe=""
      data-compact-dock=""
    >
      <div class={styles.dockViews}>
        <Show when={props.hasTrack && !props.podcast}>
          <Control
            ref={props.lyricsButtonRef}
            class={styles.dockPill}
            classList={{ [styles.dockPillActive]: props.lyricsActive }}
            aria-label={props.lyricsActive ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
            title={props.lyricsActive ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
            aria-pressed={props.lyricsActive}
            data-compact-lyrics-toggle=""
            onClick={() => props.onToggleLyrics()}
          >
            <KaraokeMicIcon size={16} />
            <span class={styles.dockPillLabel}>{t('nowPlaying.lyricsLabel')}</span>
          </Control>
        </Show>

        <Control
          class={styles.dockPill}
          classList={{ [styles.dockPillActive]: props.listActive }}
          aria-label={props.auto ? t('autoMode.panel.route') : t('nowPlaying.panel.queue')}
          title={props.auto ? t('autoMode.panel.route') : t('nowPlaying.panel.queue')}
          aria-pressed={props.listActive}
          data-compact-list-toggle=""
          onClick={() => props.onToggleList()}
        >
          <QueueListIcon size={16} />
          <span class={styles.dockPillLabel}>
            {props.auto ? t('autoMode.panel.route') : t('nowPlaying.panel.queue')}
          </span>
          <Show when={props.listCount > 0}>
            <span class={styles.dockBadge}>{props.listCount}</span>
          </Show>
        </Control>
      </div>

      <div class={styles.dockUtils}>
        <Show when={!props.auto && props.hasTrack && !props.podcast}>
          <Control
            class={styles.dockIconBtn}
            classList={{
              [styles.dockIconOn]: Boolean(player().playback.radioMode),
              [styles.dockIconPulse]: Boolean(player().playback.radioLoading),
            }}
            aria-label={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
            title={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
            aria-pressed={Boolean(player().playback.radioMode)}
            onClick={() => {
              const track = current();
              if (!track) return;
              if (player().playback.radioMode) void onStopRadio();
              else void player().actions.startRadio(track);
            }}
          >
            <RadioIcon size={18} />
          </Control>
        </Show>

        <Show when={player().can('transport.set_volume') && (!mobileWeb || player().can('transport.set_muted'))}>
          <div
            class={styles.dockVolume}
            ref={volumeRoot}
            data-no-surface-swipe=""
          >
            <Control
              class={styles.dockIconBtn}
              classList={{ [styles.dockIconOn]: volumeOpen() || Boolean(player().playback.muted) }}
              aria-label={mobileWeb ? t(player().playback.muted ? 'omnibar.unmute' : 'omnibar.mute') : t('omnibar.volume')}
              aria-expanded={mobileWeb ? undefined : volumeOpen()}
              aria-controls={!mobileWeb && volumeOpen() ? volumeId : undefined}
              aria-pressed={mobileWeb ? Boolean(player().playback.muted) : undefined}
              aria-busy={player().pending('mute') || undefined}
              data-pending={player().pending('mute') || undefined}
              title={mobileWeb ? t(player().playback.muted ? 'omnibar.unmute' : 'omnibar.mute') : t('omnibar.volume')}
              ref={volumeTrigger}
              onPointerEnter={(event) => { if (event.pointerType === 'mouse') openVolume(); }}
              onPointerLeave={leaveVolume}
              onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) openVolume(); }}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && !event.shiftKey && volumeOpen()) {
                  event.preventDefault();
                  volumePopup?.querySelector('input')?.focus({ preventScroll: true });
                }
              }}
              onClick={() => { if (player().can('transport.set_muted')) player().actions.toggleMute(); }}
            >
              <VolumeIcon muted={Boolean(player().playback.muted)} size={20} />
            </Control>
            <Show when={!mobileWeb && volumeOpen()}>
              <div
                ref={volumePopup}
                id={volumeId}
                class={styles.dockVolumePopup}
                data-no-surface-swipe=""
                onPointerEnter={cancelVolumeDismiss}
                onPointerLeave={leaveVolume}
              >
                <VolumeRange class={styles.dockVolRange} />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </nav>
  );
}
