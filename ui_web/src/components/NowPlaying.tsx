import { createEffect, createMemo, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { state, actions, nowPlayingOpen, setNowPlayingOpen } from '../stores';
import { coverUrl } from '../lib/media';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { shareTrack } from '../lib/share';
import { artistPath } from '../lib/artistRoute';
import { isPodcastTrack } from '../lib/track';
import { t as tr } from '../lib/i18n';
import { SearchPanel, panelOpen, panelSide, togglePanel } from './SearchPanel';
import styles from './NowPlaying.module.css';

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x.toString().padStart(2, '0')}`;
}

/** Full-screen Now Playing sheet. Slides up; controlled by the nowPlayingOpen signal. */
export function NowPlaying() {
  const navigate = useNavigate();
  const t = createMemo(() => state.playback.currentTrack);
  const isFav = createMemo(() => {
    const c = t();
    return !!c && state.favorites.includes(c.id);
  });
  const isPodcast = createMemo(() => {
    const c = t();
    return !!c && isPodcastTrack(c);
  });
  let dragFrom: number | null = null;
  let bodyEl: HTMLDivElement | undefined;
  let sheetEl: HTMLDivElement | undefined;
  let headEl: HTMLElement | undefined;
  // Distance (px) over which the floating "En cola" badge unwinds from its
  // hovering hint position into its docked section-header position. While
  // scrolled within [0, QUEUE_LIFT] the badge stays visually pinned (a stable
  // hint); past it, it flows to its natural spot. Must match --queue-lift in
  // NowPlaying.module.css.
  const QUEUE_LIFT = 80;
  const onBodyScroll = () => {
    if (!bodyEl) return;
    const q = Math.min(1, bodyEl.scrollTop / QUEUE_LIFT);
    bodyEl.style.setProperty('--q', q.toFixed(3));
    bodyEl.toggleAttribute('data-docked', q >= 1);
  };
  // Always (re)open on the player, with the queue badge in its hint state.
  createEffect(() => {
    if (!nowPlayingOpen() || !bodyEl) return;
    bodyEl.scrollTop = 0;
    bodyEl.style.setProperty('--q', '0');
    bodyEl.removeAttribute('data-docked');
  });

  // Swipe-down-to-close. The body is scrollable because the queue lives below
  // the player, so touch gestures need an explicit non-passive path: when the
  // body is already at the top, a downward pan belongs to the sheet instead of
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

  const bodyAtTop = () => (bodyEl?.scrollTop ?? 0) <= 1;

  const canStartSheetSwipe = (target: EventTarget | null) => {
    if (!nowPlayingOpen() || isRangeTarget(target) || !(target instanceof Node)) {
      return { allowed: false, onBody: false, bodyTop: false };
    }
    if (headEl?.contains(target)) {
      return { allowed: true, onBody: false, bodyTop: true };
    }
    const onBody = !!bodyEl?.contains(target);
    const atTop = bodyAtTop();
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
    navigate(artistPath(c.artist));
  };

  const artBg = (): JSX.CSSProperties => {
    const c = t();
    const url = c ? (c.cover ?? coverUrl(c.id)) : '';
    return url
      ? { background: `url("${url}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };
  };

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
        <button class={styles.iconBtn} type="button" aria-label={tr('common.close')} onClick={() => setNowPlayingOpen(false)}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <span class={styles.headLabel}>{tr('nowPlaying.playing')}</span>
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
      </header>

      <Show when={t()} fallback={<div class={styles.empty}>{tr('nowPlaying.nothingPlaying')}</div>}>
        <div class={styles.main} data-panel-side={panelSide()}>
        <div class={styles.body} ref={bodyEl} onScroll={onBodyScroll}>
          <div class={styles.player}>
          <div class={styles.art} style={artBg()} />

          <div class={styles.details}>
            <div class={styles.info}>
              <h1 class={styles.title}>{t()!.title}</h1>
              <Show when={artistLinkable()} fallback={<p class={styles.artist}>{t()!.artist}</p>}>
                <button class={styles.artistLink} type="button" onClick={goArtist}>
                  {t()!.artist}
                </button>
              </Show>
            </div>

            <div class={styles.seekWrap}>
            <input
              class={styles.seek}
              type="range"
              min={0}
              max={Math.max(1, Math.floor(state.playback.duration))}
              value={Math.floor(state.playback.currentTime)}
              step={1}
              aria-label={tr('nowPlaying.seekLabel')}
              onInput={(e) => actions.seek(Number(e.currentTarget.value))}
            />
            <div class={styles.times}>
              <span>{fmt(state.playback.currentTime)}</span>
              <span>{fmt(state.playback.duration)}</span>
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

            <button class={styles.play} type="button" aria-label={state.playback.isPlaying ? tr('common.pause') : tr('common.play')} onClick={() => actions.togglePlay()}>
              <Show
                when={state.playback.isPlaying}
                fallback={
                  <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                }
              >
                <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
                  <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
              </Show>
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
            <Show when={!isPodcast()}>
              <button
                class={styles.actBtn}
                classList={{ [styles.actOn]: isFav() }}
                type="button"
                aria-label={isFav() ? tr('nowPlaying.removeFav') : tr('nowPlaying.addFav')}
                aria-pressed={isFav()}
                onClick={() => actions.toggleFavourite(t()!.id)}
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill={isFav() ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" />
                </svg>
              </button>
            </Show>

            <Show when={t()!.source === 'preview' && !isPodcast()}>
              <button
                class={styles.actBtn}
                type="button"
                aria-label={tr('nowPlaying.saveToLibrary')}
                onClick={() => void actions.downloadTrack(t()!)}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
              </button>
            </Show>

            <div class={styles.volume}>
              <button
                class={styles.actBtn}
                type="button"
                aria-label={state.playback.muted ? tr('omnibar.unmute') : tr('omnibar.mute')}
                onClick={() => actions.toggleMute()}
              >
                <Show
                  when={!state.playback.muted && state.playback.volume > 0}
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
                value={Math.round((state.playback.muted ? 0 : state.playback.volume) * 100)}
                aria-label={tr('omnibar.volume')}
                onInput={(e) => actions.setVolume(Number(e.currentTarget.value) / 100)}
              />
            </div>

            <button class={styles.actBtn} type="button" aria-label={tr('nowPlaying.share')} onClick={() => void shareTrack(t()!)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12v8h16v-8M12 16V3M8 7l4-4 4 4" />
              </svg>
            </button>

            <button
              class={styles.actBtn}
              type="button"
              aria-label={tr('common.more')}
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

          <Show when={state.playback.queue.length > 1}>
            <div class={styles.queue}>
              <div class={styles.queueHead}>
                <span class={styles.queuePill}>
                  <h2 class={styles.queueTitle}>{tr('nowPlaying.queue')}</h2>
                  <svg
                    class={styles.queueChevron}
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
                <button class={styles.queueClear} type="button" onClick={() => actions.clearQueue()}>
                  {tr('nowPlaying.clearQueue')}
                </button>
              </div>
              <For each={state.playback.queue}>
                {(qt, i) => (
                  <div
                    classList={{ [styles.qRow]: true, [styles.qActive]: i() === state.playback.index }}
                    draggable={true}
                    onDragStart={(e) => {
                      dragFrom = i();
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom != null && dragFrom !== i()) actions.moveInQueue(dragFrom, i());
                      dragFrom = null;
                    }}
                  >
                    <span class={styles.qHandle} aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                      </svg>
                    </span>
                    <button class={styles.qPlay} type="button" onClick={() => actions.jumpTo(i())}>
                      <span class={styles.qIndex}>{i() + 1}</span>
                      <span class={styles.qMeta}>
                        <span class={styles.qTitle}>{qt.title}</span>
                        <span class={styles.qArtist}>{qt.artist}</span>
                      </span>
                    </button>
                    <button
                      class={styles.qRemove}
                      type="button"
                      aria-label={tr('nowPlaying.removeFromQueue')}
                      onClick={() => actions.removeFromQueue(i())}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
              </div>
            </Show>
        </div>

        <SearchPanel />
        </div>
      </Show>
    </div>
  );
}
