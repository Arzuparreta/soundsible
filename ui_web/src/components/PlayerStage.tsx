import { PodcastSkipIcon } from './PodcastSkipIcon';
import { AlbumLink, ArtistLinks } from './MusicLinks';
import { playerTrackMusic } from '../lib/musicNavigation';
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Suspense, Switch, untrack, type JSX } from 'solid-js';
import { isSavedTrack } from '../stores';
import { advancePlayback, player } from '../stores/player';
import { clockTime } from '../lib/format';
import { pageVisible } from '../lib/pageVisibility';
import { trackCoverUrl } from '../lib/media';
import { CoverImage } from './CoverImage';
import { responsiveTapConstants } from '../lib/responsiveTap';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { savedFromTrack } from '../lib/saved';
import { isPodcastTrack, PODCAST_SKIP_SECONDS } from '../lib/track';
import { t } from '../lib/i18n';
import { Control } from '../design/Control';
import { detectFormFactor } from '../lib/deviceIdentity';
import { playerCompact } from '../lib/playerDock';
import { CollectionButton } from './CollectionButton';
import { FavouriteButton } from './FavouriteButton';
import { KaraokeMicIcon, MoreIcon, NextFilledIcon, PauseFilledIcon, PlayFilledIcon, PrevFilledIcon, RadioIcon, RefreshIcon, RepeatIcon, ShuffleIcon, VolumeIcon, menuIcons } from './icons';
import { LyricsPanel } from './LyricsPanel';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { openPlaylistPicker } from './PlaylistPicker';
import { onStopRadio } from './RadioBadge';
import { Spinner } from './Spinner';
import { VolumeRange } from './VolumeRange';
import { buildTrackMenu, openTrackMenu } from './trackActions';
import type { Track } from '../types/music';
import { openActionMenu } from './ActionMenu';
import styles from './NowPlaying.module.css';

export type PlayerStageMode = 'now-playing' | 'auto';

function StageLyrics() {
  return (
    <Suspense fallback={
      <div class={styles.lyricsPending}>
        <Spinner size={22} label={t('lyricsPanel.loading')} />
      </div>
    }>
      <LyricsPanel variant="stage" />
    </Suspense>
  );
}

export function PlayerStage(props: {
  mode: PlayerStageMode;
  surfaceOpen: boolean;
  onCloseSurface?: () => void;
  onTrackDragStart?: (event: DragEvent, track: Track) => void;
  onCarryTrack?: (track: Track) => void;
  /** What the stage says with no track. Auto tells the story of its opening. */
  empty?: JSX.Element;
}) {
  const track = createMemo(() => player().playback.currentTrack);
  const podcast = createMemo(() => Boolean(track() && isPodcastTrack(track()!)));
  const [layoutBusy, setLayoutBusy] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;
  let carryTimer: number | undefined;
  let carryStart: { x: number; y: number } | null = null;
  const cancelCarry = () => {
    if (carryTimer !== undefined) window.clearTimeout(carryTimer);
    carryTimer = undefined;
    carryStart = null;
  };
  // A held finger is never perfectly still: cancelling on any movement at all
  // made the long press a gesture only a mouse could land.
  const trackCarry = (event: PointerEvent) => {
    if (!carryStart) return;
    const slop = responsiveTapConstants.TAP_SLOP;
    if (Math.abs(event.clientX - carryStart.x) > slop || Math.abs(event.clientY - carryStart.y) > slop) {
      cancelCarry();
    }
  };

  const readDesktopLyrics = () => {
    try {
      const stored = localStorage.getItem('np:desktopLyrics');
      if (stored !== null) return stored === 'open';
      const legacy = localStorage.getItem('np:panelTab') === 'lyrics';
      localStorage.removeItem('np:panelTab');
      localStorage.setItem('np:desktopLyrics', legacy ? 'open' : 'closed');
      return legacy;
    } catch {
      return false;
    }
  };
  const [desktopLyrics, setDesktopLyrics] = createSignal(readDesktopLyrics());
  const desktopLyricsActive = createMemo(() => desktopLyrics() && !podcast());
  const loading = createMemo(() => player().playback.isLoading);
  const loadFailed = createMemo(() => player().playback.loadError);
  // Seeking another device is one command on release; until then the bar holds the drag.
  const [dragged, setDragged] = createSignal<number | null>(null);
  const position = createMemo<number>((previous) => {
    if (dragged() !== null) return dragged()!;
    if (!pageVisible()) return previous ?? untrack(() => player().playback.currentTime);
    return props.surfaceOpen ? player().playback.currentTime : untrack(() => player().playback.currentTime);
  });
  const seekPct = () => {
    const duration = player().playback.duration;
    return duration > 0 ? Math.min(100, (position() / duration) * 100) : 0;
  };
  const mobileWeb = detectFormFactor() !== 'computer';

  const muteButton = () => (
    <Show when={player().can('transport.set_muted')}>
      <Control
        class={styles.actBtn}
        classList={{ [styles.actOn]: player().playback.muted }}
        aria-label={player().playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
        aria-pressed={player().playback.muted}
        aria-busy={player().pending('mute') || undefined}
        data-pending={player().pending('mute') || undefined}
        title={player().playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
        onClick={() => player().actions.toggleMute()}
      >
        <VolumeIcon muted={Boolean(player().playback.muted)} size={20} />
      </Control>
    </Show>
  );

  const animateRects = (before: Map<Element, DOMRect>) => {
    if (prefersReducedMotion()) return;
    requestAnimationFrame(() => {
      for (const element of rootEl?.querySelectorAll<HTMLElement>('[data-lyrics-morph]') ?? []) {
        const first = before.get(element);
        const last = element.getBoundingClientRect();
        if (!first || !last.width || !last.height) continue;
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        const sx = first.width / last.width;
        const sy = first.height / last.height;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        element.animate(
          [
            { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
            { transformOrigin: 'top left', transform: 'none' },
          ],
          { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    });
  };

  const toggleDesktopLyrics = () => {
    if (layoutBusy() || podcast()) return;
    const before = new Map(
      [...(rootEl?.querySelectorAll<HTMLElement>('[data-lyrics-morph]') ?? [])]
        .map((element) => [element, element.getBoundingClientRect()] as const),
    );
    const next = !desktopLyrics();
    setLayoutBusy(true);
    setDesktopLyrics(next);
    try {
      localStorage.setItem('np:desktopLyrics', next ? 'open' : 'closed');
    } catch {
      /* storage disabled/full */
    }
    animateRects(before);
    window.setTimeout(() => setLayoutBusy(false), 440);
  };

  onMount(() => {
    // Document bubble runs after OverlayOutlet (window capture) and inline dock
    // popovers (document capture), and before the global window bubble shortcut
    // handler, so Escape folds desktop lyrics instead of closing the player.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && props.surfaceOpen && !playerCompact() && desktopLyricsActive()) {
        event.preventDefault();
        event.stopPropagation();
        toggleDesktopLyrics();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  const openStageTrackMenu = (item: Track) => {
    openTrackMenu(item, {
      music: playerTrackMusic(item),
      onAddToPlaylist: openPlaylistPicker,
      onEditMetadata: openMetadataEditor,
      onPlayOnDevice: openPlayOnDevice,
    });
  };

  const openLyricsOverflow = () => {
    const current = track();
    if (!current) return;
    openActionMenu({
      title: current.title,
      subtitle: current.artist,
      actions: [
        ...(props.mode === 'now-playing' ? [
          {
            icon: menuIcons.shuffle(),
            label: t('nowPlaying.shuffle'),
            selected: player().playback.shuffle,
            onSelect: () => player().actions.toggleShuffle(),
          },
          {
            icon: menuIcons.repeat(),
            label: t('nowPlaying.repeat'),
            selected: player().playback.repeat !== 'off',
            onSelect: () => player().actions.cycleRepeat(),
          },
          {
            icon: menuIcons.radio(),
            label: player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio'),
            onSelect: () => player().playback.radioMode ? void onStopRadio() : void player().actions.startRadio(current),
          },
        ] : []),
        ...buildTrackMenu(current, {
          music: playerTrackMusic(current),
          auto: props.mode === 'auto',
          onAddToPlaylist: openPlaylistPicker,
          onEditMetadata: openMetadataEditor,
          onPlayOnDevice: openPlayOnDevice,
        }).filter((action) => action.label !== t('trackActions.startRadio')),
      ],
    });
  };

  return (
    <>
      <div
        ref={rootEl}
        class={styles.body}
        classList={{ [styles.desktopLyricsStage]: desktopLyricsActive() }}
        data-player-stage-mode={props.mode}
        data-lyrics-stage={desktopLyricsActive() ? '' : undefined}
      >
        <Show when={track()} fallback={props.empty ?? <div class={styles.empty}>{t('nowPlaying.nothingPlaying')}</div>}>
          {(current) => (
            <>
              <div class={styles.media}>
                <div class={styles.visualFrame}>
                  <div
                    class={styles.visualSlot}
                    data-player-cover-slot=""
                    data-now-playing-cover-slot={props.mode === 'now-playing' ? '' : undefined}
                    data-auto-cover-slot={props.mode === 'auto' ? '' : undefined}
                    data-lyrics-morph=""
                  >
                    <div
                      class={styles.art}
                      style={{ position: 'relative', background: 'var(--bg-raised)' }}
                      role="img"
                      aria-label={current().title}
                      draggable={Boolean(props.onTrackDragStart)}
                      onDragStart={(event) => props.onTrackDragStart?.(event, current())}
                      onPointerDown={(event) => {
                        if (!props.onCarryTrack) return;
                        cancelCarry();
                        carryStart = { x: event.clientX, y: event.clientY };
                        carryTimer = window.setTimeout(() => props.onCarryTrack?.(current()), 460);
                      }}
                      onPointerMove={trackCarry}
                      onPointerUp={cancelCarry}
                      onPointerCancel={cancelCarry}
                    >
                      <CoverImage src={trackCoverUrl(current())} eager={props.surfaceOpen} />
                    </div>
                    <Show when={desktopLyricsActive()}>
                      <div class={styles.desktopLyrics}>
                        <StageLyrics />
                      </div>
                    </Show>
                  </div>
                </div>
              </div>

              <div class={styles.controlsPanel}>
                <div class={styles.info} data-lyrics-morph="">
                  <div class={styles.meta}>
                    <h1 class={styles.title} title={current().title}>{current().title}</h1>
                    <p class={styles.byline}>
                      <ArtistLinks class={styles.artist} music={playerTrackMusic(current())} />
                      <Show when={playerTrackMusic(current()).linkable !== false && current().album?.trim()}>
                        <span class={styles.bylineSeparator} aria-hidden="true">·</span>
                        <AlbumLink class={styles.album} music={playerTrackMusic(current())} />
                      </Show>
                    </p>
                  </div>
                  <div class={styles.infoActions}>
                    {/* No wrapper here: once the song is downloaded the button
                        renders nothing, and an empty box would still be a flex
                        item — a second gap beside the heart. */}
                    <Show when={!podcast()}>
                      <CollectionButton
                        entry={savedFromTrack(current())}
                        class={`${styles.actBtn} ${styles.collectionAction}`}
                        hideOwned
                        tooltip
                      />
                    </Show>
                    <Show when={!podcast() && isSavedTrack(current())}>
                      <span class={styles.favouriteAction}>
                        <FavouriteButton favourite={savedFromTrack(current())} class={styles.actBtn} tooltip />
                      </span>
                    </Show>
                    <Control
                      class={`${styles.actBtn} ${styles.compactMoreAction}`}
                      aria-label={t('common.more')}
                      title={t('common.more')}
                      onClick={() => openStageTrackMenu(current())}
                    >
                      <MoreIcon size={20} />
                    </Control>
                  </div>
                </div>

                <div class={styles.seekWrap} data-lyrics-morph="">
                  <input
                    class={styles.seek}
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(player().playback.duration))}
                    value={Math.floor(position())}
                    step={1}
                    style={{ '--fill': `${seekPct()}%` }}
                    aria-label={t('nowPlaying.seekLabel')}
                    aria-busy={player().pending('seek') || undefined}
                    disabled={player().unreachable}
                    onInput={(event) => {
                      const value = Number(event.currentTarget.value);
                      if (player().remote) setDragged(value);
                      else player().actions.seek(value);
                    }}
                    onChange={(event) => {
                      if (!player().remote) return;
                      setDragged(null);
                      player().actions.seek(Number(event.currentTarget.value));
                    }}
                  />
                  <div class={styles.times}>
                    <span>{clockTime(position())}</span>
                    <span>{clockTime(player().playback.duration)}</span>
                  </div>
                </div>

                <div class={styles.controls} data-lyrics-morph="">
                  <Show when={props.mode === 'now-playing'}>
                    <button
                      classList={{ [styles.toggle]: true, [styles.on]: player().playback.shuffle }}
                      type="button"
                      aria-label={t('nowPlaying.shuffle')}
                      aria-pressed={player().playback.shuffle}
                      aria-busy={player().pending('shuffle') || undefined}
                      data-pending={player().pending('shuffle') || undefined}
                      onClick={() => player().actions.toggleShuffle()}
                    >
                      <ShuffleIcon size={20} />
                    </button>
                  </Show>

                  <button
                    class={styles.ctrl}
                    type="button"
                    aria-label={podcast() ? t('podcasts.skipBack') : t('common.prev')}
                    aria-busy={player().pending('prev') || undefined}
                    data-pending={player().pending('prev') || undefined}
                    onClick={() => podcast() ? player().actions.seekBy(-PODCAST_SKIP_SECONDS) : player().actions.prev()}
                  >
                    <Show when={podcast()} fallback={<PrevFilledIcon size={30} />}>
                      <PodcastSkipIcon backward />
                    </Show>
                  </button>

                  <button
                    class={styles.play}
                    type="button"
                    aria-label={loadFailed() ? t('common.retry') : player().playback.isPlaying ? t('common.pause') : t('common.play')}
                    aria-busy={loading() || player().pending('play')}
                    data-pending={player().pending('play') || undefined}
                    onClick={() => player().actions.togglePlay()}
                  >
                    <Switch>
                      <Match when={loadFailed()}>
                        <RefreshIcon size={30} />
                      </Match>
                      <Match when={loading()}>
                        <Spinner size={26} onAccent />
                      </Match>
                      <Match when={player().playback.isPlaying}>
                        <PauseFilledIcon size={32} />
                      </Match>
                      <Match when={true}>
                        <PlayFilledIcon size={32} />
                      </Match>
                    </Switch>
                  </button>

                  <button
                    class={styles.ctrl}
                    type="button"
                    aria-label={podcast() ? t('podcasts.skipForward') : t('common.next')}
                    aria-busy={player().pending('next') || undefined}
                    data-pending={player().pending('next') || undefined}
                    onClick={() => advancePlayback(props.mode)}
                  >
                    <Show when={podcast()} fallback={<NextFilledIcon size={30} />}>
                      <PodcastSkipIcon />
                    </Show>
                  </button>

                  <Show when={props.mode === 'now-playing'}>
                    <button
                      classList={{ [styles.toggle]: true, [styles.on]: player().playback.repeat !== 'off' }}
                      type="button"
                      aria-label={t('nowPlaying.repeat')}
                      aria-busy={player().pending('repeat') || undefined}
                      data-pending={player().pending('repeat') || undefined}
                      onClick={() => player().actions.cycleRepeat()}
                    >
                      <RepeatIcon size={20} />
                      <Show when={player().playback.repeat === 'one'}>
                        <span class={styles.repeatOne}>1</span>
                      </Show>
                    </button>
                  </Show>
                </div>

                {/* Wide full-screen actions bar. Compact layouts own lyrics,
                    queue/route, radio and volume in PlayerSurface's persistent
                    bottom dock so they stay reachable across every view. */}
                <div class={styles.actionsBar} data-stage-actions="" data-lyrics-morph="">
                  <Show when={!podcast()}>
                    <Control
                      class={`${styles.actBtn} ${styles.desktopLyricsToggle}`}
                      classList={{ [styles.actOn]: desktopLyricsActive() }}
                      aria-label={desktopLyricsActive() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      title={desktopLyricsActive() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      aria-pressed={desktopLyricsActive()}
                      disabled={layoutBusy()}
                      onClick={toggleDesktopLyrics}
                    >
                      <KaraokeMicIcon size={20} />
                    </Control>
                  </Show>

                  <Show when={props.mode === 'now-playing' && !podcast()}>
                    <Control
                      class={`${styles.actBtn} ${styles.radioAction}`}
                      classList={{
                        [styles.actOn]: player().playback.radioMode,
                        [styles.actPulse]: player().playback.radioLoading,
                      }}
                      aria-label={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      title={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      aria-pressed={player().playback.radioMode}
                      onClick={() => (player().playback.radioMode ? void onStopRadio() : void player().actions.startRadio(current()))}
                    >
                      <RadioIcon size={20} />
                    </Control>
                  </Show>

                  <Show when={player().can('transport.set_volume') && (!mobileWeb || player().can('transport.set_muted'))}>
                    <div
                      class={styles.volume}
                      classList={{ [styles.volumeNoSlider]: mobileWeb }}
                      data-no-surface-swipe=""
                    >
                      {muteButton()}
                      <Show when={!mobileWeb}>
                        <span class={styles.volumePopover}><VolumeRange class={styles.volRange} /></span>
                      </Show>
                    </div>
                  </Show>

                  <Control
                    class={styles.actBtn}
                    aria-label={t('common.more')}
                    title={t('common.more')}
                    onClick={() => desktopLyricsActive()
                      ? openLyricsOverflow()
                      : openStageTrackMenu(current())}
                  >
                    <MoreIcon size={20} />
                  </Control>
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  );
}
