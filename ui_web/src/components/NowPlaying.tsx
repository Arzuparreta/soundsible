import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { state, actions, isSavedTrack, nowPlayingOpen, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { artistPath } from '../lib/artistRoute';
import { isPodcastTrack } from '../lib/track';
import { savedFromTrack } from '../lib/saved';
import { FavouriteButton } from './FavouriteButton';
import { CollectionButton } from './CollectionButton';
import { t as tr } from '../lib/i18n';
import { SearchPanel, panelOpen, panelSide, togglePanel } from './SearchPanel';
import { RadioBadge, onStopRadio } from './RadioBadge';
import { Spinner } from './Spinner';
import { LyricsPanel } from './LyricsPanel';
import styles from './NowPlaying.module.css';
import { clockTime } from '../lib/format';
import type { PlaybackQueueEntry } from '../lib/playbackQueue';

type MobileVisualSurface = 'cover' | 'queue' | 'lyrics';

/** Full-screen Now Playing sheet. Slides up; controlled by the nowPlayingOpen signal. */
export function NowPlaying() {
  const navigate = useNavigate();
  const t = createMemo(() => state.playback.currentTrack);
  const isPodcast = createMemo(() => {
    const c = t();
    return !!c && isPodcastTrack(c);
  });
  const loading = createMemo(() => state.playback.isLoading);
  const loadFailed = createMemo(() => state.playback.loadError);
  const [mobileSurface, setMobileSurface] = createSignal<MobileVisualSurface>('cover');
  let dragFrom: number | null = null;
  let bodyEl: HTMLDivElement | undefined;
  let desktopQueueEl: HTMLDivElement | undefined;
  let mobileQueueEl: HTMLDivElement | undefined;
  let mobileLyricsEl: HTMLDivElement | undefined;
  let sheetEl: HTMLDivElement | undefined;
  let headEl: HTMLElement | undefined;
  // Always (re)open at the top of the sheet.
  createEffect(() => {
    if (!nowPlayingOpen()) {
      setMobileSurface('cover');
      return;
    }
    if (bodyEl) bodyEl.scrollTop = 0;
    if (desktopQueueEl) desktopQueueEl.scrollTop = 0;
    if (mobileQueueEl) mobileQueueEl.scrollTop = 0;
  });

  createEffect(() => {
    if (mobileSurface() === 'queue' && state.playback.queue.length <= 1) {
      setMobileSurface('cover');
    }
  });

  createEffect(() => {
    if (mobileSurface() === 'queue' && mobileQueueEl) mobileQueueEl.scrollTop = 0;
  });

  createEffect(() => {
    // Auto's shared-cover handoff must always start and land on artwork. The
    // rectangle itself stays unchanged; only the compact surface resets.
    if (isPodcast() || state.autoMode.active) setMobileSurface('cover');
  });

  // Swipe-down-to-close. The queue is its own scroll container below the player,
  // so touch gestures need an explicit non-passive path: when the active scroll
  // area is already at the top, a downward pan belongs to the sheet instead of
  // the native scroll container.
  let swipeStartY = 0;
  let swipeActive = false;
  let swipeOnBody = false;
  let swipeBodyAtTop = false;
  let swipeStartAt = 0;
  // A drag only exists between a pointerdown on the sheet and its pointerup.
  // pointermove on a mouse also fires on bare hover (no button held), so without
  // tracking an in-progress gesture a hover over the freshly-opened sheet would
  // be read as a swipe (stale swipeStartY=0 → phantom drag that never ends).
  let pointerDown = false;
  let activePointerId: number | null = null;
  /** Px of downward drag that closes the sheet on release. Tuned for a
   * comfortable mobile thumb swipe — roughly 1/8 of a typical phone height. */
  const SWIPE_CLOSE_THRESHOLD = 80;
  const SWIPE_FAST_CLOSE_THRESHOLD = 32;
  const SWIPE_CLOSE_VELOCITY = 0.45;
  /** Px of downward movement that activates swipe-to-close. Below this we
   * treat the gesture as a tap or horizontal interaction and stay out of the
   * way (so seek/volume sliders and button taps work normally). */
  const SWIPE_ACTIVATE_THRESHOLD = 8;
  const HORIZONTAL_CANCEL_THRESHOLD = 12;

  const isRangeTarget = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('input[type="range"]');

  const activeScrollAtTop = (target: EventTarget | null) => {
    if (target instanceof Node && mobileQueueEl?.contains(target)) {
      return mobileQueueEl.scrollTop <= 1;
    }
    if (target instanceof Node && mobileLyricsEl?.contains(target)) {
      return mobileLyricsEl.scrollTop <= 1;
    }
    if (target instanceof Node && desktopQueueEl?.contains(target)) {
      return desktopQueueEl.scrollTop <= 1;
    }
    return (bodyEl?.scrollTop ?? 0) <= 1;
  };

  const canStartSheetSwipe = (target: EventTarget | null) => {
    if (!nowPlayingOpen() || isRangeTarget(target) || !(target instanceof Node)) {
      return { allowed: false, onBody: false, bodyTop: false };
    }
    if (headEl?.contains(target)) {
      return { allowed: true, onBody: false, bodyTop: true };
    }
    const onBody = !!bodyEl?.contains(target);
    const atTop = activeScrollAtTop(target);
    return { allowed: onBody && atTop, onBody, bodyTop: atTop };
  };

  const beginSheetSwipe = (clientY: number, start: ReturnType<typeof canStartSheetSwipe>) => {
    swipeStartY = clientY;
    swipeStartAt = performance.now();
    swipeActive = false;
    swipeOnBody = start.onBody;
    swipeBodyAtTop = start.bodyTop;
  };

  const activateSheetSwipe = () => {
    if (!sheetEl) return;
    swipeActive = true;
    // Disable the open/close transition so the sheet tracks the finger 1:1.
    // Restored on release.
    sheetEl.setAttribute('data-swiping', '');
  };

  const updateSheetSwipe = (deltaY: number) => {
    if (!sheetEl) return;
    sheetEl.style.transform = `translateY(${Math.max(0, deltaY)}px)`;
  };

  const onSheetPointerDown = (e: PointerEvent) => {
    if (!nowPlayingOpen() || e.pointerType === 'touch') return;
    // Only the primary pointer (first finger / left mouse button). Multi-touch
    // and right-clicks fall through to the element beneath.
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const start = canStartSheetSwipe(e.target);
    if (!start.allowed) return;
    pointerDown = true;
    activePointerId = e.pointerId;
    beginSheetSwipe(e.clientY, start);
  };

  const onSheetPointerMove = (e: PointerEvent) => {
    // Ignore moves that aren't part of a gesture started on this sheet (e.g. a
    // bare mouse hover over the open sheet, which would otherwise drag it down).
    if (!pointerDown || e.pointerId !== activePointerId) return;
    if (!nowPlayingOpen() || !sheetEl) return;
    const deltaY = e.clientY - swipeStartY;
    if (!swipeActive) {
      if (deltaY <= SWIPE_ACTIVATE_THRESHOLD) return;
      if (swipeOnBody && !swipeBodyAtTop) return;
      activateSheetSwipe();
      // Keep receiving move/up even if the pointer leaves the sheet, so a drag
      // that ends off-element still gets its pointerup (no stuck transform).
      try {
        sheetEl.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone — nothing to capture */
      }
    }
    updateSheetSwipe(deltaY);
  };

  const endSwipe = (close: boolean) => {
    if (!swipeActive || !sheetEl) return;
    swipeActive = false;
    sheetEl.removeAttribute('data-swiping');
    if (close) setNowPlayingOpen(false);
    // Clear the inline transform on the next frame so the CSS transition can
    // animate from the finger's release position to translateY(0) (snap back)
    // or translateY(100%) (close, once .open is removed above).
    requestAnimationFrame(() => {
      if (sheetEl) sheetEl.style.transform = '';
    });
  };

  const onSheetPointerUp = (e: PointerEvent) => {
    if (!pointerDown || e.pointerId !== activePointerId) return;
    pointerDown = false;
    activePointerId = null;
    const deltaY = e.clientY - swipeStartY;
    const elapsed = Math.max(1, performance.now() - swipeStartAt);
    const velocity = deltaY / elapsed;
    endSwipe(deltaY > SWIPE_CLOSE_THRESHOLD || (deltaY > SWIPE_FAST_CLOSE_THRESHOLD && velocity > SWIPE_CLOSE_VELOCITY));
  };

  const onSheetPointerCancel = () => {
    pointerDown = false;
    activePointerId = null;
    endSwipe(false);
  };

  let touchAllowed = false;
  let activeTouchId: number | null = null;
  let touchStartX = 0;

  const resetTouchSwipe = () => {
    touchAllowed = false;
    activeTouchId = null;
  };

  const touchById = (touches: TouchList) => {
    if (activeTouchId == null) return null;
    for (let i = 0; i < touches.length; i += 1) {
      const touch = touches.item(i);
      if (touch?.identifier === activeTouchId) return touch;
    }
    return null;
  };

  const onSheetTouchStart = (e: TouchEvent) => {
    if (!nowPlayingOpen() || e.touches.length !== 1) {
      resetTouchSwipe();
      return;
    }
    const start = canStartSheetSwipe(e.target);
    if (!start.allowed) {
      resetTouchSwipe();
      return;
    }
    const touch = e.touches.item(0);
    if (!touch) return;
    touchAllowed = true;
    activeTouchId = touch.identifier;
    touchStartX = touch.clientX;
    beginSheetSwipe(touch.clientY, start);
  };

  const onSheetTouchMove = (e: TouchEvent) => {
    if (!touchAllowed || !sheetEl) return;
    const touch = touchById(e.touches);
    if (!touch) return;
    const deltaY = touch.clientY - swipeStartY;
    const deltaX = touch.clientX - touchStartX;

    if (!swipeActive) {
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > HORIZONTAL_CANCEL_THRESHOLD) {
        resetTouchSwipe();
        return;
      }
      if (deltaY <= 0) return;
      if (swipeOnBody && !swipeBodyAtTop) return;
      // Critical on mobile Safari/Chrome: without a non-passive preventDefault,
      // the scroll container owns the downward pan and cancels the sheet drag.
      e.preventDefault();
      if (deltaY <= SWIPE_ACTIVATE_THRESHOLD) return;
      activateSheetSwipe();
    } else {
      e.preventDefault();
    }
    updateSheetSwipe(deltaY);
  };

  const onSheetTouchEnd = (e: TouchEvent) => {
    if (!touchAllowed) return;
    const touch = touchById(e.changedTouches);
    if (!touch) return;
    const deltaY = touch.clientY - swipeStartY;
    const elapsed = Math.max(1, performance.now() - swipeStartAt);
    const velocity = deltaY / elapsed;
    resetTouchSwipe();
    endSwipe(deltaY > SWIPE_CLOSE_THRESHOLD || (deltaY > SWIPE_FAST_CLOSE_THRESHOLD && velocity > SWIPE_CLOSE_VELOCITY));
  };

  const onSheetTouchCancel = () => {
    resetTouchSwipe();
    endSwipe(false);
  };

  onMount(() => {
    if (!sheetEl) return;
    sheetEl.addEventListener('touchstart', onSheetTouchStart, { passive: true });
    sheetEl.addEventListener('touchmove', onSheetTouchMove, { passive: false });
    sheetEl.addEventListener('touchend', onSheetTouchEnd, { passive: true });
    sheetEl.addEventListener('touchcancel', onSheetTouchCancel, { passive: true });
    onCleanup(() => {
      sheetEl?.removeEventListener('touchstart', onSheetTouchStart);
      sheetEl?.removeEventListener('touchmove', onSheetTouchMove);
      sheetEl?.removeEventListener('touchend', onSheetTouchEnd);
      sheetEl?.removeEventListener('touchcancel', onSheetTouchCancel);
    });
  });
  /** Library tracks link to their artist; preview/podcast sources do not. */
  const artistLinkable = createMemo(() => {
    const c = t();
    return !!c && c.source !== 'preview' && !!c.artist;
  });
  const goArtist = () => {
    const c = t();
    if (!c?.artist) return;
    setNowPlayingOpen(false);
    navigate(artistPath(c.artist, { view: c.source === 'preview' ? 'discover' : 'library' }));
  };

  const artBg = (): JSX.CSSProperties => {
    const c = t();
    const url = c ? (c.cover ?? coverUrl(c.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

  const seekPct = () => {
    const d = state.playback.duration;
    return d > 0 ? Math.min(100, (state.playback.currentTime / d) * 100) : 0;
  };
  const volPct = () => Math.round((state.playback.muted ? 0 : state.playback.volume) * 100);
  const [contextExpanded, setContextExpanded] = createSignal(false);
  const [generatedExpanded, setGeneratedExpanded] = createSignal(false);
  const currentQueueEntry = createMemo(() => state.playback.queue[state.playback.index]);
  const manualQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'manual'),
  );
  const contextQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'context'),
  );
  const generatedQueue = createMemo(() =>
    state.playback.queue.slice(state.playback.index + 1).filter((entry) => entry.queueLane === 'generated'),
  );
  const visibleContextQueue = createMemo(() => contextExpanded() ? contextQueue() : contextQueue().slice(0, 5));
  const visibleGeneratedQueue = createMemo(() => generatedExpanded() ? generatedQueue() : generatedQueue().slice(0, 3));

  const QueueRow = (props: { entry: PlaybackQueueEntry; current?: boolean; ordinal?: number }) => {
    const queueIndex = () => state.playback.queue.findIndex((entry) => entry.queueId === props.entry.queueId);
    return (
      <div
        classList={{ [styles.qRow]: true, [styles.qActive]: !!props.current }}
        draggable={!props.current}
        onDragStart={(e) => {
          dragFrom = queueIndex();
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!props.current) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const to = queueIndex();
          if (dragFrom != null && dragFrom !== to) actions.moveInQueue(dragFrom, to);
          dragFrom = null;
        }}
      >
        <Show when={!props.current} fallback={<span class={styles.qHandle} aria-hidden="true" />}>
          <span class={styles.qHandle} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
              <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
              <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
            </svg>
          </span>
        </Show>
        <button
          class={styles.qPlay}
          type="button"
          disabled={props.current}
          onClick={() => actions.playQueueEntry(props.entry.queueId)}
        >
          <span class={styles.qIndex}>
            <Show when={props.current} fallback={<>{props.ordinal ?? ''}</>}>
              <span class={styles.eq} data-paused={state.playback.isPlaying ? undefined : ''} aria-hidden="true">
                <i /><i /><i />
              </span>
            </Show>
          </span>
          <span class={styles.qMeta}>
            <span class={styles.qTitle}>{props.entry.title}</span>
            <span class={styles.qArtist}>{props.entry.artist}</span>
          </span>
        </button>
        <Show when={!props.current}>
          <button
            class={styles.qRemove}
            type="button"
            aria-label={tr('nowPlaying.removeFromQueue')}
            onClick={() => actions.removeQueueEntry(props.entry.queueId)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Show>
      </div>
    );
  };

  const QueueSection = (props: {
    label: string;
    entries: PlaybackQueueEntry[];
    total: number;
    expanded?: boolean;
    toggle?: () => void;
  }) => (
    <Show when={props.total > 0}>
      <section class={styles.queueSection}>
        <div class={styles.queueSectionHead}>
          <span>{props.label}</span>
          <span class={styles.queueSectionCount}>{props.total}</span>
        </div>
        <For each={props.entries}>
          {(entry, index) => <QueueRow entry={entry} ordinal={index() + 1} />}
        </For>
        <Show when={props.toggle && props.total > props.entries.length || (props.toggle && props.expanded)}>
          <button class={styles.queueExpand} type="button" onClick={props.toggle}>
            {props.expanded ? tr('nowPlaying.showLess') : tr('nowPlaying.showAll', { count: props.total })}
          </button>
        </Show>
      </section>
    </Show>
  );

  const QueueList = (props: { className: string; setRef: (el: HTMLDivElement) => void }) => (
    <div class={`${styles.queue} ${props.className}`}>
      <div class={styles.queueHead}>
        <span class={styles.queueHeading}>
          <h2 class={styles.queueTitle}>{tr('nowPlaying.queue')}</h2>
          <span class={styles.queueCount}>
            {1 + manualQueue().length + contextQueue().length + generatedQueue().length}
          </span>
        </span>
        <button
          class={styles.queueClear}
          type="button"
          disabled={manualQueue().length === 0}
          onClick={() => actions.clearManualQueue()}
        >
          {tr('nowPlaying.clearManualQueue')}
        </button>
      </div>
      <div class={styles.queueRows} ref={props.setRef}>
        <Show when={currentQueueEntry()}>
          {(entry) => (
            <section class={styles.queueSection}>
              <div class={styles.queueSectionHead}>{tr('nowPlaying.nowPlayingSection')}</div>
              <QueueRow entry={entry()} current />
            </section>
          )}
        </Show>
        <QueueSection
          label={tr('nowPlaying.manualQueue')}
          entries={manualQueue()}
          total={manualQueue().length}
        />
        <QueueSection
          label={contextQueue()[0]?.queueContext?.label || tr('nowPlaying.contextQueue')}
          entries={visibleContextQueue()}
          total={contextQueue().length}
          expanded={contextExpanded()}
          toggle={() => setContextExpanded((value) => !value)}
        />
        <QueueSection
          label={state.playback.radioMode
            ? tr('nowPlaying.radioQueue')
            : state.autoMode.active
              ? tr('nowPlaying.autoQueue')
              : tr('nowPlaying.autoplayQueue')}
          entries={visibleGeneratedQueue()}
          total={generatedQueue().length}
          expanded={generatedExpanded()}
          toggle={() => setGeneratedExpanded((value) => !value)}
        />
        <Show when={manualQueue().length + contextQueue().length + generatedQueue().length === 0}>
          <p class={styles.queueEmpty}>{tr('nowPlaying.queueEmpty')}</p>
        </Show>
      </div>
    </div>
  );

  return (
    <div
      ref={sheetEl}
      classList={{ [styles.sheet]: true, [styles.open]: nowPlayingOpen() }}
      aria-hidden={!nowPlayingOpen()}
      onPointerDown={onSheetPointerDown}
      onPointerMove={onSheetPointerMove}
      onPointerUp={onSheetPointerUp}
      onPointerCancel={onSheetPointerCancel}
    >
      <header class={styles.head} ref={headEl}>
        <div class={styles.headLeading}>
          <button
            classList={{ [styles.iconBtn]: true, [styles.panelToggle]: true, [styles.panelToggleOn]: panelOpen() }}
            type="button"
            aria-label={panelOpen() ? tr('nowPlaying.hideSearchPanel') : tr('nowPlaying.showSearchPanel')}
            aria-pressed={panelOpen()}
            onClick={togglePanel}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </button>
          <Show when={t() && !isPodcast()}>
            <button
              class={styles.autoToggle}
              type="button"
              aria-label={tr('autoMode.enter')}
              aria-pressed={state.autoMode.active}
              onClick={() => actions.enterAutoMode()}
            >
              <span class={styles.autoGlyph} aria-hidden="true"><i /><i /><i /></span>
              <span class={styles.autoWord}>AUTO</span>
            </button>
          </Show>
        </div>
        <span class={styles.headLabel}>{tr('nowPlaying.playing')}</span>
        <button class={styles.iconBtn} type="button" aria-label={tr('common.close')} onClick={() => setNowPlayingOpen(false)}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </header>

      <Show when={t()} fallback={<div class={styles.empty}>{tr('nowPlaying.nothingPlaying')}</div>}>
        <div class={styles.main} data-panel-side={panelSide()}>
        <div class={styles.body} ref={bodyEl}>
          <div class={styles.media}>
            <div
              class={styles.visualSlot}
              data-queue-open={mobileSurface() === 'queue' ? '' : undefined}
              data-lyrics-open={mobileSurface() === 'lyrics' ? '' : undefined}
              data-now-playing-cover-slot=""
            >
              <div class={styles.art} style={artBg()} />
              <Show when={state.playback.queue.length > 1 && mobileSurface() === 'queue'}>
                <QueueList className={styles.mobileQueue} setRef={(el) => { mobileQueueEl = el; }} />
              </Show>
              <Show when={!isPodcast() && mobileSurface() === 'lyrics'}>
                <div class={styles.mobileLyrics}>
                  <LyricsPanel scrollRef={(element) => { mobileLyricsEl = element; }} />
                </div>
              </Show>
              <Show when={!isPodcast() && mobileSurface() !== 'queue'}>
                <button
                  classList={{
                    [styles.mobileLyricsToggle]: true,
                    [styles.mobileLyricsToggleOn]: mobileSurface() === 'lyrics',
                  }}
                  type="button"
                  aria-label={mobileSurface() === 'lyrics' ? tr('nowPlaying.showCover') : tr('nowPlaying.showLyrics')}
                  aria-pressed={mobileSurface() === 'lyrics'}
                  onClick={() => setMobileSurface((surface) => surface === 'lyrics' ? 'cover' : 'lyrics')}
                >
                  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M5 6h14M5 10h10M5 14h14M5 18h8" />
                  </svg>
                </button>
              </Show>
            </div>
            <div class={styles.info}>
              <div class={styles.titleRow}>
                <h1 class={styles.title}>{t()!.title}</h1>
                <Show when={t()!.audio_quality === 'lossless' && t()!.audio_identity_verified}>
                  <span class={styles.losslessBadge} title={t()!.audio_source || 'Lossless'}>
                    LOSSLESS
                  </span>
                </Show>
                <RadioBadge class={styles.radioBadge} loadingClass={styles.radioBadgeLoading} />
              </div>
              <Show when={artistLinkable()} fallback={<p class={styles.artist}>{t()!.artist}</p>}>
                <button class={styles.artistLink} type="button" onClick={goArtist}>
                  {t()!.artist}
                </button>
              </Show>
            </div>
          </div>

          <div class={styles.controlsPanel}>
            <div class={styles.seekWrap}>
            <input
              class={styles.seek}
              type="range"
              min={0}
              max={Math.max(1, Math.floor(state.playback.duration))}
              value={Math.floor(state.playback.currentTime)}
              step={1}
              style={{ '--fill': `${seekPct()}%` }}
              aria-label={tr('nowPlaying.seekLabel')}
              onInput={(e) => actions.seek(Number(e.currentTarget.value))}
            />
            <div class={styles.times}>
              <span>{clockTime(state.playback.currentTime)}</span>
              <span>{clockTime(state.playback.duration)}</span>
            </div>
            </div>

            <div class={styles.controls}>
            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.shuffle }}
              type="button"
              aria-label={tr('nowPlaying.shuffle')}
              aria-pressed={state.playback.shuffle}
              onClick={() => actions.toggleShuffle()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
            </button>

            <button class={styles.ctrl} type="button" aria-label={tr('common.prev')} onClick={() => actions.prev()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </button>

            <button
              class={styles.play}
              type="button"
              aria-label={loadFailed() ? tr('common.retry') : state.playback.isPlaying ? tr('common.pause') : tr('common.play')}
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

            <button class={styles.ctrl} type="button" aria-label={tr('common.next')} onClick={() => actions.next()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" />
              </svg>
            </button>

            <button
              classList={{ [styles.toggle]: true, [styles.on]: state.playback.repeat !== 'off' }}
              type="button"
              aria-label={tr('nowPlaying.repeat')}
              onClick={() => actions.cycleRepeat()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" />
              </svg>
              <Show when={state.playback.repeat === 'one'}>
                <span class={styles.repeatOne}>1</span>
              </Show>
            </button>
            </div>

            <div class={styles.actionsBar}>
            <Show when={state.playback.queue.length > 1}>
              <button
                classList={{
                  [styles.actBtn]: true,
                  [styles.mobileQueueToggle]: true,
                  [styles.actOn]: mobileSurface() === 'queue',
                }}
                type="button"
                aria-label={tr('nowPlaying.queue')}
                aria-pressed={mobileSurface() === 'queue'}
                onClick={() => setMobileSurface((surface) => surface === 'queue' ? 'cover' : 'queue')}
              >
                <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M11 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                  <path d="M17 17V4h4M13 5H3M3 9h10M9 13H3" />
                </svg>
              </button>
            </Show>

            {/* Marking presupposes having: what is playing may be a stream you
              * have never claimed, and the ＋ next to it is how you claim it. */}
            <Show when={!isPodcast() && isSavedTrack(t()!)}>
              <FavouriteButton favourite={savedFromTrack(t()!)} class={styles.actBtn} tooltip />
            </Show>

            <Show when={!isPodcast()}>
              <CollectionButton
                entry={savedFromTrack(t()!)}
                class={styles.actBtn}
                hideOwned
                tooltip
              />
            </Show>

            {/* Radio earns a permanent slot because it is the only action here
                that carries state — active, and loading while the mix resolves.
                A menu item cannot show either. Everything else that used to sit
                in this bar (playlist, edit, play-on-device, share) is one tap
                away in ⋯, where it was duplicated from anyway. */}
            <Show when={!isPodcast()}>
              <button
                classList={{
                  [styles.actBtn]: true,
                  [styles.actOn]: state.playback.radioMode,
                  [styles.actPulse]: state.playback.radioLoading,
                }}
                type="button"
                aria-label={state.playback.radioMode ? tr('nowPlaying.stopRadioTitle') : tr('trackActions.startRadio')}
                title={state.playback.radioMode ? tr('nowPlaying.stopRadioTitle') : tr('trackActions.startRadio')}
                aria-pressed={state.playback.radioMode}
                onClick={() => (state.playback.radioMode ? void onStopRadio() : void actions.startRadio(t()!))}
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
                aria-label={state.playback.muted ? tr('omnibar.unmute') : tr('omnibar.mute')}
                aria-pressed={state.playback.muted}
                title={state.playback.muted ? tr('omnibar.unmute') : tr('omnibar.mute')}
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
                aria-label={tr('omnibar.volume')}
                onInput={(e) => actions.setVolume(Number(e.currentTarget.value) / 100)}
              />
            </div>

            <button
              class={styles.actBtn}
              type="button"
              aria-label={tr('common.more')}
              title={tr('common.more')}
              onClick={() =>
                openTrackMenu(t()!, {
                  navigate,
                  onAddToPlaylist: openPlaylistPicker,
                  onEditMetadata: openMetadataEditor,
                  onPlayOnDevice: openPlayOnDevice,
                })
              }
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            </div>
          </div>
        </div>

        {/* Desktop queue column: always mounted while something plays so the
            three-panel layout stays stable (no columns popping in and out as
            the queue grows or shrinks). Hidden below 768px by CSS. */}
        <QueueList className={styles.desktopQueue} setRef={(el) => { desktopQueueEl = el; }} />

        <SearchPanel />
        </div>
      </Show>
    </div>
  );
}
