import { createEffect, createSignal, createUniqueId, onCleanup, Show } from 'solid-js';
import { isCurrentTrackPodcast, isPlaybackSilent, player } from '../stores/player';
import { t } from '../lib/i18n';
import { playerCompact } from '../lib/playerDock';
import { isTouchFormFactor } from '../lib/deviceIdentity';
import { isEditableTextControl } from '../lib/shortcuts';
import { Control } from '../design/Control';
import { KaraokeMicIcon, QueueListIcon, RadioIcon, VolumeIcon } from './icons';
import { onStopRadio } from './RadioBadge';
import { VolumeRange } from './VolumeRange';
import styles from './PlayerCompactDock.module.css';

// Brief grace delay so the pointer can cross from the trigger to the popup.
const VOLUME_DISMISS_MS = 160;

/**
 * Persistent compact bottom bar shared by Stage, Queue/Route and Lyrics (below `PLAYER_COMPACT_BELOW`).
 *
 * View toggles sit on the left; playback utilities sit on the right. On
 * `mobileWeb` phones the volume button is a direct mute toggle; on desktop
 * docked columns hover or keyboard focus opens a vertical slider popover above the
 * button while clicks still toggle mute.
 *
 * Unlike `PlayerStage`'s wide fullscreen slider (CSS `:hover` / `:focus-within`),
 * this bottom-edge popover uses explicit JS state: it needs `aria-expanded` /
 * `Tab`-into-slider keyboard flow, dismissal on outside clicks/scroll/resize,
 * and layered `Escape` handling above compact lyrics without `openOverlay`'s
 * backdrop blocking pointer hover travel.
 */
export function PlayerCompactDock(props: {
  auto: boolean;
  lyricsActive: boolean;
  listActive: boolean;
  listCount: number;
  surfaceOpen: boolean;
  onToggleLyrics: () => void;
  onToggleList: () => void;
  lyricsButtonRef?: (element: HTMLButtonElement) => void;
}) {
  const [volumeOpen, setVolumeOpen] = createSignal(false);
  const mobileWeb = isTouchFormFactor();
  const volumeId = createUniqueId();
  let volumeRoot: HTMLDivElement | undefined;
  let volumeTrigger: HTMLButtonElement | undefined;
  let volumePopup: HTMLDivElement | undefined;
  let volumeDismissTimer: ReturnType<typeof setTimeout> | undefined;

  const current = () => player().playback.currentTrack;
  const lyricsLabel = () => (props.lyricsActive ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics'));
  const listLabel = () => (props.auto ? t('autoMode.panel.route') : t('nowPlaying.panel.queue'));
  const radioLabel = () => (player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio'));
  const volumeLabel = () => (mobileWeb ? t(player().playback.muted ? 'omnibar.unmute' : 'omnibar.mute') : t('omnibar.volume'));

  const cancelVolumeDismiss = () => clearTimeout(volumeDismissTimer);
  onCleanup(cancelVolumeDismiss);
  const closeVolume = () => {
    cancelVolumeDismiss();
    setVolumeOpen(false);
  };
  // Focus returns before closeVolume() so :focus-visible on volumeTrigger cannot immediately reopen the popup.
  const dismissKeepingTriggerFocus = () => {
    if (volumePopup?.contains(document.activeElement)) {
      volumeTrigger?.focus({ preventScroll: true });
    }
    closeVolume();
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
    }, VOLUME_DISMISS_MS);
  };
  createEffect(() => {
    if (!props.surfaceOpen || !playerCompact() || !player().can('transport.set_volume')) setVolumeOpen(false);
  });
  createEffect(() => {
    if (!volumeOpen()) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !volumeRoot?.contains(event.target) && !volumePopup?.contains(event.target)) closeVolume();
    };
    // Only dismiss when the scrolling container moves the dock itself, not sibling panes like synced lyrics.
    const dismissOnScroll = (event: Event) => {
      if (!volumeRoot || !(event.target instanceof Node) || event.target.contains(volumeRoot)) {
        dismissKeepingTriggerFocus();
      }
    };
    // See lib/shortcuts.ts for player Escape layering; external editable text controls keep Escape.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!(target && volumePopup?.contains(target)) && isEditableTextControl(target)) {
        closeVolume();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      dismissKeepingTriggerFocus();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);
    document.addEventListener('scroll', dismissOnScroll, true);
    document.addEventListener('keydown', onEscape, true);
    window.addEventListener('resize', dismissKeepingTriggerFocus);
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
      document.removeEventListener('scroll', dismissOnScroll, true);
      document.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('resize', dismissKeepingTriggerFocus);
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
        <Show when={current() && !isCurrentTrackPodcast()}>
          <Control
            ref={props.lyricsButtonRef}
            class={styles.dockPill}
            classList={{ [styles.dockPillActive]: props.lyricsActive }}
            aria-label={t('nowPlaying.lyricsLabel')}
            title={lyricsLabel()}
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
          aria-label={props.listCount > 0 ? `${listLabel()} ${props.listCount}` : listLabel()}
          title={listLabel()}
          aria-pressed={props.listActive}
          data-compact-list-toggle=""
          onClick={() => props.onToggleList()}
        >
          <QueueListIcon size={16} />
          <span class={styles.dockPillLabel}>{listLabel()}</span>
          <Show when={props.listCount > 0}>
            <span class={styles.dockBadge}>{props.listCount}</span>
          </Show>
        </Control>
      </div>

      <div class={styles.dockUtils}>
        <Show when={!props.auto && current() && !isCurrentTrackPodcast()}>
          <Control
            class={styles.dockIconBtn}
            classList={{
              [styles.dockIconOn]: Boolean(player().playback.radioMode),
              [styles.dockIconPulse]: Boolean(player().playback.radioLoading),
            }}
            aria-label={radioLabel()}
            title={radioLabel()}
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
              classList={{ [styles.dockIconOn]: mobileWeb ? Boolean(player().playback.muted) : volumeOpen() }}
              aria-label={volumeLabel()}
              aria-expanded={mobileWeb ? undefined : volumeOpen()}
              aria-controls={!mobileWeb && volumeOpen() ? volumeId : undefined}
              aria-pressed={mobileWeb ? Boolean(player().playback.muted) : undefined}
              aria-busy={player().pending('mute') || undefined}
              data-pending={player().pending('mute') || undefined}
              title={volumeLabel()}
              ref={volumeTrigger}
              onPointerEnter={(event) => { if (event.pointerType === 'mouse') openVolume(); }}
              onPointerLeave={leaveVolume}
              // Open only on keyboard focus; pointer clicks toggle mute instead.
              onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) openVolume(); }}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && !event.shiftKey && volumeOpen()) {
                  event.preventDefault();
                  volumePopup?.querySelector('input')?.focus({ preventScroll: true });
                }
              }}
              onClick={() => { if (player().can('transport.set_muted')) player().actions.toggleMute(); }}
            >
              <VolumeIcon muted={isPlaybackSilent()} size={20} />
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
