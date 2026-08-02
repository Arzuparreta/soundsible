import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Suspense, Switch, untrack, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { actions, isSavedTrack, state } from '../stores';
import { artistPath } from '../lib/artistRoute';
import { clockTime } from '../lib/format';
import { coverUrl } from '../lib/media';
import {
  initialMobileVisualState,
  toggleMobileLyrics,
} from '../lib/nowPlayingMobileVisual';
import { savedFromTrack } from '../lib/saved';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { CollectionButton } from './CollectionButton';
import { FavouriteButton } from './FavouriteButton';
import { KaraokeMicIcon } from './icons';
import { LyricsPanel } from './LyricsPanel';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { openPlaylistPicker } from './PlaylistPicker';
import { RadioBadge, onStopRadio } from './RadioBadge';
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
  listActive?: boolean;
  listLabel?: string;
  onTrackDragStart?: (event: DragEvent, track: Track) => void;
  onCarryTrack?: (track: Track) => void;
}) {
  const navigate = useNavigate();
  const track = createMemo(() => state.playback.currentTrack);
  const podcast = createMemo(() => Boolean(track() && isPodcastTrack(track()!)));
  const [mobileVisual, setMobileVisual] = createSignal(initialMobileVisualState);
  const [layoutBusy, setLayoutBusy] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;
  let carryTimer: number | undefined;
  const cancelCarry = () => {
    if (carryTimer !== undefined) window.clearTimeout(carryTimer);
    carryTimer = undefined;
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
  const loading = createMemo(() => state.playback.isLoading);
  const loadFailed = createMemo(() => state.playback.loadError);
  const position = createMemo(() => (
    props.surfaceOpen ? state.playback.currentTime : untrack(() => state.playback.currentTime)
  ));
  const seekPct = () => {
    const duration = state.playback.duration;
    return duration > 0 ? Math.min(100, (position() / duration) * 100) : 0;
  };
  const volPct = () => Math.round((state.playback.muted ? 0 : state.playback.volume) * 100);
  const artistLinkable = createMemo(() => {
    const current = track();
    return Boolean(current && current.source !== 'preview' && current.artist);
  });
  const artBg = (): JSX.CSSProperties => {
    const current = track();
    const url = current ? (current.cover ?? coverUrl(current.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

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

  const goArtist = () => {
    const current = track();
    if (!current?.artist) return;
    props.onCloseSurface?.();
    navigate(artistPath(current.artist, { view: current.source === 'preview' ? 'discover' : 'library' }));
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
            label: `${state.playback.shuffle ? '✓  ' : ''}${t('nowPlaying.shuffle')}`,
            onSelect: () => actions.toggleShuffle(),
          },
          {
            label: `${state.playback.repeat !== 'off' ? '✓  ' : ''}${t('nowPlaying.repeat')}`,
            onSelect: () => actions.cycleRepeat(),
          },
          {
            label: state.playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio'),
            onSelect: () => state.playback.radioMode ? void onStopRadio() : void actions.startRadio(current),
          },
        ] : []),
        ...buildTrackMenu(current, {
          onAddToPlaylist: openPlaylistPicker,
          onEditMetadata: openMetadataEditor,
          onPlayOnDevice: openPlayOnDevice,
        }).filter((action) => action.label !== t('trackActions.startRadio')),
      ],
    });
  };

  const next = () => {
    if (props.mode === 'auto') void actions.autoSkip();
    else actions.next();
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
        <Show when={track()} fallback={<div class={styles.empty}>{t('common.nothingPlaying')}</div>}>
          {(current) => (
            <>
              <div class={styles.media}>
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
                    style={artBg()}
                    role="img"
                    aria-label={current().title}
                    draggable={Boolean(props.onTrackDragStart)}
                    onDragStart={(event) => props.onTrackDragStart?.(event, current())}
                    onPointerDown={() => {
                      if (!props.onCarryTrack) return;
                      cancelCarry();
                      carryTimer = window.setTimeout(() => props.onCarryTrack?.(current()), 460);
                    }}
                    onPointerMove={cancelCarry}
                    onPointerUp={cancelCarry}
                    onPointerCancel={cancelCarry}
                  />
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
                  <Show when={!podcast()}>
                    <button
                      classList={{
                        [styles.mobileLyricsToggle]: true,
                        [styles.mobileLyricsToggleOn]: mobileVisual().content === 'lyrics',
                      }}
                      type="button"
                      aria-label={mobileVisual().content === 'lyrics' ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      aria-pressed={mobileVisual().content === 'lyrics'}
                      onClick={() => setMobileVisual(toggleMobileLyrics)}
                    >
                      <KaraokeMicIcon size={21} />
                    </button>
                  </Show>
                  <Show when={desktopLyricsActive()}>
                    <div class={styles.desktopLyrics}>
                      <StageLyrics />
                    </div>
                  </Show>
                  <Show when={!podcast()}>
                    <button
                      classList={{
                        [styles.desktopLyricsToggle]: true,
                        [styles.desktopLyricsToggleOn]: desktopLyricsActive(),
                      }}
                      type="button"
                      aria-label={desktopLyricsActive() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                      aria-pressed={desktopLyricsActive()}
                      disabled={layoutBusy()}
                      onClick={toggleDesktopLyrics}
                    >
                      <Show
                        when={!desktopLyricsActive()}
                        fallback={
                          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <path d="m7 16 4-4 3 3 2-2 2 3" />
                          </svg>
                        }
                      >
                        <KaraokeMicIcon size={21} />
                      </Show>
                    </button>
                  </Show>
                </div>
                <div class={styles.info} data-lyrics-morph="">
                  <div class={styles.titleRow}>
                    <h1 class={styles.title}>{current().title}</h1>
                    <Show when={current().audio_quality === 'lossless' && current().audio_identity_verified}>
                      <span class={styles.losslessBadge} title={current().audio_source || 'Lossless'}>
                        LOSSLESS
                      </span>
                    </Show>
                    <Show when={props.mode === 'now-playing'}>
                      <RadioBadge class={styles.radioBadge} loadingClass={styles.radioBadgeLoading} />
                    </Show>
                  </div>
                  <Show when={artistLinkable()} fallback={<p class={styles.artist}>{current().artist}</p>}>
                    <button class={styles.artistLink} type="button" onClick={goArtist}>
                      {current().artist}
                    </button>
                  </Show>
                </div>
              </div>

              <div class={styles.controlsPanel}>
                <div class={styles.seekWrap} data-lyrics-morph="">
                  <input
                    class={styles.seek}
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(state.playback.duration))}
                    value={Math.floor(position())}
                    step={1}
                    style={{ '--fill': `${seekPct()}%` }}
                    aria-label={t('nowPlaying.seekLabel')}
                    onInput={(event) => actions.seek(Number(event.currentTarget.value))}
                  />
                  <div class={styles.times}>
                    <span>{clockTime(position())}</span>
                    <span>{clockTime(state.playback.duration)}</span>
                  </div>
                </div>

                <div class={styles.controls} data-lyrics-morph="">
                  <Show when={props.mode === 'now-playing'}>
                    <button
                      classList={{ [styles.toggle]: true, [styles.on]: state.playback.shuffle }}
                      type="button"
                      aria-label={t('nowPlaying.shuffle')}
                      aria-pressed={state.playback.shuffle}
                      onClick={() => actions.toggleShuffle()}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
                      </svg>
                    </button>
                  </Show>

                  <button class={styles.ctrl} type="button" aria-label={t('common.prev')} onClick={() => actions.prev()}>
                    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                      <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                    </svg>
                  </button>

                  <button
                    class={styles.play}
                    type="button"
                    aria-label={loadFailed() ? t('common.retry') : state.playback.isPlaying ? t('common.pause') : t('common.play')}
                    aria-busy={loading()}
                    onClick={() => actions.togglePlay()}
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
                      <Match when={state.playback.isPlaying}>
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

                  <button class={styles.ctrl} type="button" aria-label={t('common.next')} onClick={next}>
                    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                      <path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" />
                    </svg>
                  </button>

                  <Show when={props.mode === 'now-playing'}>
                    <button
                      classList={{ [styles.toggle]: true, [styles.on]: state.playback.repeat !== 'off' }}
                      type="button"
                      aria-label={t('nowPlaying.repeat')}
                      onClick={() => actions.cycleRepeat()}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
                      </svg>
                      <Show when={state.playback.repeat === 'one'}>
                        <span class={styles.repeatOne}>1</span>
                      </Show>
                    </button>
                  </Show>
                </div>

                <div class={styles.actionsBar} data-lyrics-morph="">
                  <Show when={props.onOpenList && state.playback.queue.length > 1}>
                    <button
                      classList={{
                        [styles.actBtn]: true,
                        [styles.mobileQueueToggle]: true,
                        [styles.actOn]: props.listActive,
                      }}
                      type="button"
                      aria-label={props.listLabel ?? t('nowPlaying.queue')}
                      aria-pressed={props.listActive}
                      onClick={props.onOpenList}
                    >
                      <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M11 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                        <path d="M17 17V4h4M13 5H3M3 9h10M9 13H3" />
                      </svg>
                    </button>
                  </Show>

                  <Show when={!podcast() && isSavedTrack(current())}>
                    <FavouriteButton favourite={savedFromTrack(current())} class={styles.actBtn} tooltip />
                  </Show>

                  <Show when={!podcast()}>
                    <span class={styles.collectionAction}>
                      <CollectionButton
                        entry={savedFromTrack(current())}
                        class={styles.actBtn}
                        hideOwned
                        tooltip
                      />
                    </span>
                  </Show>

                  <Show when={props.mode === 'now-playing' && !podcast()}>
                    <button
                      classList={{
                        [styles.actBtn]: true,
                        [styles.radioAction]: true,
                        [styles.actOn]: state.playback.radioMode,
                        [styles.actPulse]: state.playback.radioLoading,
                      }}
                      type="button"
                      aria-label={state.playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      title={state.playback.radioMode ? t('nowPlaying.stopRadioTitle') : t('trackActions.startRadio')}
                      aria-pressed={state.playback.radioMode}
                      onClick={() => (state.playback.radioMode ? void onStopRadio() : void actions.startRadio(current()))}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                  </Show>

                  <div class={styles.volume}>
                    <button
                      class={styles.actBtn}
                      classList={{ [styles.actOn]: state.playback.muted }}
                      type="button"
                      aria-label={state.playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
                      aria-pressed={state.playback.muted}
                      title={state.playback.muted ? t('omnibar.unmute') : t('omnibar.mute')}
                      onClick={() => actions.toggleMute()}
                    >
                      <Show
                        when={!state.playback.muted}
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
                    <input
                      class={styles.volRange}
                      type="range"
                      min={0}
                      max={100}
                      value={volPct()}
                      style={{ '--fill': `${volPct()}%` }}
                      aria-label={t('omnibar.volume')}
                      onInput={(event) => actions.setVolume(Number(event.currentTarget.value) / 100)}
                    />
                  </div>

                  <button
                    class={styles.actBtn}
                    type="button"
                    aria-label={t('common.more')}
                    title={t('common.more')}
                    onClick={() => desktopLyricsActive()
                      ? openLyricsOverflow()
                      : openTrackMenu(current(), {
                          navigate,
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
