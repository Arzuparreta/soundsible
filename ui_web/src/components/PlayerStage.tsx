import { PodcastSkipIcon } from './PodcastSkipIcon';
import { AlbumLink, ArtistLinks } from './MusicLinks';
import { playerTrackMusic } from '../lib/musicNavigation';
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Suspense, Switch, untrack, type JSX } from 'solid-js';
import { isSavedTrack } from '../stores';
import { player } from '../stores/player';
import { clockTime } from '../lib/format';
import { pageVisible } from '../lib/pageVisibility';
import { trackCoverUrl } from '../lib/media';
import { CoverImage } from './CoverImage';
import {
  initialMobileVisualState,
  toggleMobileLyrics,
} from '../lib/nowPlayingMobileVisual';
import { responsiveTapConstants } from '../lib/responsiveTap';
import { savedFromTrack } from '../lib/saved';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { gainToVolumePosition, volumePositionToGain } from '../lib/volumeScale';
import { CollectionButton } from './CollectionButton';
import { FavouriteButton } from './FavouriteButton';
import { KaraokeMicIcon, RadioIcon, RepeatIcon, ShuffleIcon, menuIcons } from './icons';
import { LyricsPanel } from './LyricsPanel';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { openPlaylistPicker } from './PlaylistPicker';
import { onStopRadio } from './RadioBadge';
import { Spinner } from './Spinner';
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
  dragHandle?: JSX.Element;
  onCloseSurface?: () => void;
  onOpenList?: () => void;
  listLabel?: string;
  onTrackDragStart?: (event: DragEvent, track: Track) => void;
  onCarryTrack?: (track: Track) => void;
  /** What the stage says with no track. Auto tells the story of its opening. */
  empty?: JSX.Element;
}) {
  const track = createMemo(() => player().playback.currentTrack);
  const podcast = createMemo(() => Boolean(track() && isPodcastTrack(track()!)));
  const [mobileVisual, setMobileVisual] = createSignal(initialMobileVisualState);
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
  const volPct = () => Math.round(gainToVolumePosition(player().playback.muted ? 0 : player().playback.volume) * 100);


  createEffect(() => {
    if (!props.surfaceOpen || podcast()) setMobileVisual(initialMobileVisualState);
  });

  const animateRects = (before: Map<Element, DOMRect>) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && desktopLyricsActive()) {
        event.preventDefault();
        toggleDesktopLyrics();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

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
        // The one Auto-native thing to do with the song on air now has a button
        // of its own in the actions bar — the song playing is not in the route
        // panel, so a menu entry was the only way to reach it and nothing said
        // it was there.
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

  const next = () => {
    if (props.mode === 'auto') void player().actions.autoSkip();
    else player().actions.next();
  };

  return (
    <>
      {props.dragHandle}
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
                    data-lyrics-open={mobileVisual().content === 'lyrics' ? '' : undefined}
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
                    <Show when={!podcast() && mobileVisual().content === 'lyrics'}>
                      <div class={styles.mobileLyrics}>
                        <Suspense fallback={
                          <div class={styles.lyricsPending}>
                            <Spinner size={22} label={t('lyricsPanel.loading')} />
                          </div>
                        }>
                          <LyricsPanel />
                        </Suspense>
                      </div>
                    </Show>
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
                    onClick={() => podcast() ? player().actions.seekBy(-15) : player().actions.prev()}
                  >
                    <Show when={podcast()} fallback={<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>}>
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
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                          <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
                        </svg>
                      </Match>
                      <Match when={loading()}>
                        <Spinner size={26} onAccent />
                      </Match>
                      <Match when={player().playback.isPlaying}>
                        <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                          <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                        </svg>
                      </Match>
                      <Match when={true}>
                        <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                          <path fill="currentColor" d="M8 5v14l11-7z" />
                        </svg>
                      </Match>
                    </Switch>
                  </button>

                  <button
                    class={styles.ctrl}
                    type="button"
                    aria-label={podcast() ? t('podcasts.skipForward') : t('common.next')}
                    aria-busy={player().pending('next') || undefined}
                    data-pending={player().pending('next') || undefined}
                    onClick={() => podcast() ? player().actions.seekBy(15) : next()}
                  >
                    <Show when={podcast()} fallback={<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>}>
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

                <div class={styles.actionsBar} data-lyrics-morph="">
                  <Show when={!podcast()}>
                    <button
                      classList={{
                        [styles.actBtn]: true,
                        [styles.mobileLyricsToggle]: true,
                        [styles.actOn]: mobileVisual().content === 'lyrics',
                      }}
                      type="button"
                      aria-label={mobileVisual().content === 'lyrics' ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      title={mobileVisual().content === 'lyrics' ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      aria-pressed={mobileVisual().content === 'lyrics'}
                      onClick={() => setMobileVisual(toggleMobileLyrics)}
                    >
                      <KaraokeMicIcon size={20} />
                    </button>
                    <button
                      classList={{
                        [styles.actBtn]: true,
                        [styles.desktopLyricsToggle]: true,
                        [styles.actOn]: desktopLyricsActive(),
                      }}
                      type="button"
                      aria-label={desktopLyricsActive() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      title={desktopLyricsActive() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      aria-pressed={desktopLyricsActive()}
                      disabled={layoutBusy()}
                      onClick={toggleDesktopLyrics}
                    >
                      <KaraokeMicIcon size={20} />
                    </button>
                  </Show>

                  <Show when={props.onOpenList && player().playback.queue.length > 1}>
                    <button
                      classList={{ [styles.actBtn]: true, [styles.mobileQueueToggle]: true }}
                      type="button"
                      aria-label={props.listLabel ?? t('nowPlaying.queue')}
                      title={props.listLabel ?? t('nowPlaying.queue')}
                      onClick={props.onOpenList}
                    >
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                        <path d="M17 17V4h4M13 5H3M3 9h10M9 13H3" />
                      </svg>
                    </button>
                  </Show>

                  <Show when={props.mode === 'now-playing' && !podcast()}>
                    <button
                      classList={{
                        [styles.actBtn]: true,
                        [styles.radioAction]: true,
                        [styles.actOn]: player().playback.radioMode,
                        [styles.actPulse]: player().playback.radioLoading,
                      }}
                      type="button"
                      aria-label={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      title={player().playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      aria-pressed={player().playback.radioMode}
                      onClick={() => (player().playback.radioMode ? void onStopRadio() : void player().actions.startRadio(current()))}
                    >
                      <RadioIcon size={20} />
                    </button>
                  </Show>

                  <Show when={player().can('transport.set_volume')}>
                    <div class={styles.volume}>
                      <Show when={player().can('transport.set_muted')}>
                        <button
                          class={styles.actBtn}
                          classList={{ [styles.actOn]: player().playback.muted }}
                          type="button"
                          aria-label={player().playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
                          aria-pressed={player().playback.muted}
                          aria-busy={player().pending('mute') || undefined}
                          data-pending={player().pending('mute') || undefined}
                          title={player().playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
                          onClick={() => player().actions.toggleMute()}
                        >
                          <Show
                            when={!player().playback.muted}
                            fallback={
                              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />
                              </svg>
                            }
                          >
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
                            </svg>
                          </Show>
                        </button>
                      </Show>
                      <span class={styles.volumePopover}>
                        <input
                          class={styles.volRange}
                          type="range"
                          min={0}
                          max={100}
                          value={volPct()}
                          style={{ '--fill': `${volPct()}%` }}
                          aria-label={t('omnibar.volume')}
                          aria-valuetext={`${volPct()}%`}
                          onInput={(event) => player().actions.setVolume(volumePositionToGain(Number(event.currentTarget.value) / 100))}
                        />
                      </span>
                    </div>
                  </Show>

                  <button
                    class={styles.actBtn}
                    type="button"
                    aria-label={t('common.more')}
                    title={t('common.more')}
                    onClick={() => desktopLyricsActive()
                      ? openLyricsOverflow()
                      : openTrackMenu(current(), {
                          music: playerTrackMusic(current()),
                          onAddToPlaylist: openPlaylistPicker,
                          onEditMetadata: openMetadataEditor,
                          onPlayOnDevice: openPlayOnDevice,
                        })}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="19" cy="12" r="2" />
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  );
}
