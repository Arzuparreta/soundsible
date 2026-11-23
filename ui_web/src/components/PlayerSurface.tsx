import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, Suspense, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { nowPlayingOpen, setNowPlayingOpen } from '../stores';
import { player } from '../stores/player';
import { trackCoverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { t } from '../lib/i18n';
import { type AutoModePanelId } from '../lib/autoModeLayout';
import {
  DOCK_WIDTH,
  PLAYER_COMPACT_BELOW,
  playerCompact,
  playerDocked,
  playerDockMaxWidth,
  playerDockWidth,
  playerDockWidthCustom,
  playerPresentation,
  setPlayerCompact,
  setPlayerDockWidth,
  setPlayerPresentation,
} from '../lib/playerDock';
import { desktopShell } from '../lib/shellLayout';
import { SeamReset } from './SeamReset';
import { scrollableAncestor } from '../lib/scrollableAncestor';
import { createTouchMoveLease } from '../lib/touchMoveLease';
import { Control } from '../design/Control';
import { connectLabel, openConnect } from './DeviceSheet';
import { OutputDeviceIcon } from './icons';
import { ArtworkBackdrop } from './ArtworkBackdrop';
import { PlayerCompactDock } from './PlayerCompactDock';
import { PlayerMiniHeader } from './PlayerMiniHeader';
import { Spinner } from './Spinner';
import { pageVisible } from '../lib/pageVisibility';
import type { NowPlayingMobilePanel } from './NowPlaying';
import { deferredComponent } from '../lib/deferredComponent';
import { recoverAutoMode, recoverNowPlaying } from './nowPlayingRecovery';
import styles from './PlayerSurface.module.css';

const NowPlaying = deferredComponent<Parameters<typeof import('./NowPlaying').NowPlaying>[0]>(
  async () => ({ default: (await import('./playerViews')).NowPlaying }),
  async () => ({ default: await recoverNowPlaying() }),
  styles.autoLoading,
);

const AutoMode = deferredComponent<Parameters<typeof import('./AutoMode').AutoMode>[0]>(
  async () => ({ default: (await import('./playerViews')).AutoMode }),
  async () => ({ default: await recoverAutoMode() }),
  styles.autoLoading,
);

const CompactLyrics = deferredComponent<NonNullable<Parameters<typeof import('./LyricsPanel').LyricsPanel>[0]>>(
  async () => ({ default: (await import('./playerViews')).LyricsPanel }),
  async () => ({ default: (await import('./LyricsPanel')).LyricsPanel }),
  styles.lyricsPending,
);

const SWIPE_CLOSE_THRESHOLD = 80;
const SWIPE_FAST_CLOSE_THRESHOLD = 32;
const SWIPE_CLOSE_VELOCITY = 0.45;
const SWIPE_ACTIVATE_THRESHOLD = 2;
const HORIZONTAL_CANCEL_THRESHOLD = 6;
/** How much taller than wide a drag must be before it counts as a close. */
const SWIPE_VERTICAL_BIAS = 1.5;
/* Time the exit is worth end to end; a partial travel is scaled down from it.
   Deliberately under the 300ms of the entrance (--dur-medium): leaving should
   feel a step quicker than arriving. Kept in sync with the CSS fallback. */
const EXIT_DURATION = 260;
/** Floor for the last sliver, so a release near the bottom still moves visibly. */
const EXIT_DURATION_MIN = 110;
/** Grace on top of the exit before the fallback timer gives up on `animationend`. */
const CLOSE_ANIMATION_GRACE = 140;
/* Controls that own the touch themselves. Plain buttons are deliberately absent:
   in the mobile layout the queue rows *are* full-width buttons, so excluding
   them left most of the surface unswipeable. A tap never
   activates the gesture, and once it does the browser cancels the click. */
const SWIPE_EXCLUDED = 'input, textarea, select, [data-rail], [data-lyrics-scroll], [data-no-surface-swipe]';
/** Arrow keys move the docked column's edge by this much. */
const DOCK_KEY_STEP = 24;
type PlayerPanel = NowPlayingMobilePanel | AutoModePanelId;

type BackdropState = {
  first: string;
  second: string;
  active: 'first' | 'second';
};

/**
 * The player environment shared by Now Playing and Auto Mode. On a phone it is
 * a sheet over the app; on a desktop it is docked as a column beside the app,
 * or fills the screen (lib/playerDock). Its composition follows its own width,
 * not the window's: a docked column is laid out the way a phone is.
 */
export function PlayerSurface() {
  const [opened, setOpened] = createSignal(nowPlayingOpen());
  createEffect(() => { if (nowPlayingOpen()) setOpened(true); });
  const current = createMemo(() => player().playback.currentTrack);
  const podcast = createMemo(() => Boolean(current() && isPodcastTrack(current()!)));
  const auto = createMemo(() => player().autoMode.active);
  const autoAvailable = createMemo(() => !current() || !isPodcastTrack(current()!));
  const art = createMemo(() => {
    const track = current();
    return track ? trackCoverUrl(track, 'thumb') ?? '' : '';
  });
  const [mobilePanel, setMobilePanel] = createSignal<PlayerPanel>('stage');
  const [compactLyrics, setCompactLyrics] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [surfaceSettled, setSurfaceSettled] = createSignal(untrack(nowPlayingOpen));
  const [surfaceAnimating, setSurfaceAnimating] = createSignal(false);
  const docked = playerDocked;
  const [backdrops, setBackdrops] = createSignal<BackdropState>({
    first: art(),
    second: '',
    active: 'first',
  });
  let surfaceEl: HTMLDivElement | undefined;
  let lyricsToggleEl: HTMLButtonElement | undefined;
  let restoreFocus: HTMLElement | null = null;
  let wasOpen = untrack(nowPlayingOpen);
  let wasAuto = auto();
  let swipeStart: { x: number; y: number; at: number; id: number; scroller: HTMLElement | null } | null = null;
  let swipeActive = false;
  let touchMove: ReturnType<typeof createTouchMoveLease> | undefined;
  let closeTimer: number | undefined;
  let openTimer: number | undefined;
  let focusTimer: number | undefined;
  /* Where the exit starts and how long it is worth, handed over by whatever
     closed the surface. Null when the close came from somewhere that has no
     gesture behind it — the keyboard shortcut — which then gets the full exit. */
  let pendingExit: { from: number; duration: number } | null = null;

  const listPanel = createMemo<PlayerPanel>(() => (auto() ? 'route' : 'queue'));
  const isListPanel = createMemo(() => mobilePanel() === listPanel());
  const listCount = createMemo(() => {
    const queue = player().playback.queue ?? [];
    const index = player().playback.index ?? 0;
    const upcoming = queue.slice(Math.max(0, index + 1));
    if (auto()) return upcoming.length;
    const radioMode = Boolean(player().playback.radioMode);
    return upcoming.filter((entry) =>
      entry.queueLane === 'manual' || (radioMode && entry.queueLane === 'generated'),
    ).length;
  });

  createEffect(() => {
    const next = art();
    const currentState = backdrops();
    const visible = currentState.active === 'first' ? currentState.first : currentState.second;
    if (next === visible) return;
    setBackdrops((value) => value.active === 'first'
      ? { ...value, second: next, active: 'second' }
      : { ...value, first: next, active: 'first' });
  });

  const setPanel = (panel: PlayerPanel) => {
    setCompactLyrics(false);
    setMobilePanel(panel);
  };

  const closeCompactLyrics = () => {
    setPanel('stage');
    // Unmounting the compact lyrics overlay would drop focus to <body>; return
    // focus to its dock toggle (or Stage) so keyboard navigation keeps its place.
    queueMicrotask(() => {
      (lyricsToggleEl ?? surfaceEl?.querySelector<HTMLElement>('[data-player-tile="stage"]'))
        ?.focus({ preventScroll: true });
    });
  };

  const toggleCompactLyrics = () => {
    if (!playerCompact() || !current() || podcast()) return;
    if (compactLyrics()) closeCompactLyrics();
    else setCompactLyrics(true);
  };

  const toggleListPanel = () => {
    const target = listPanel();
    setPanel(compactLyrics() || mobilePanel() !== target ? target : 'stage');
  };

  // Single source of truth for compact lyrics: leaving compact widths (e.g.
  // docked -> full screen), losing the track, or playing a podcast clears it
  // so narrowing again later never unexpectedly reveals a stale lyrics screen.
  createEffect(() => {
    if (!playerCompact() || !current() || podcast()) setCompactLyrics(false);
  });

  createEffect(() => {
    const active = auto();
    requestAnimationFrame(() => {
      if (!surfaceEl) return;
      surfaceEl.scrollLeft = 0;
      surfaceEl.scrollTop = 0;
    });
    // Landing on the stage card, not opening the surface: what raises the
    // surface is the listener asking for Auto (`actions.enterAutoMode`), so a
    // session put back on boot — this device's own, or one picked up from
    // another — restores the workspace behind the collapsed shell instead of
    // throwing the player up over whatever they opened the app to do.
    if (active !== wasAuto) setPanel('stage');
    wasAuto = active;
  });

  const clearOpenSettle = () => {
    window.clearTimeout(openTimer);
    openTimer = undefined;
    window.clearTimeout(focusTimer);
    focusTimer = undefined;
    surfaceEl?.removeEventListener('transitionend', onOpenTransitionEnd);
  };

  const settleOpen = () => {
    clearOpenSettle();
    setSurfaceAnimating(false);
    if (!untrack(nowPlayingOpen)) return;
    setSurfaceSettled(true);
    focusTimer = window.setTimeout(() => {
      focusTimer = undefined;
      if (!untrack(nowPlayingOpen) || !surfaceEl) return;
      // Focus that already reached a control in the player stays there: a
      // listener who tabbed in, or grabbed the docked column's edge, first.
      if (surfaceEl.contains(document.activeElement)) return;
      surfaceEl.focus({ preventScroll: true });
    }, 60);
  };

  const onOpenTransitionEnd = (event: TransitionEvent) => {
    if (event.target === surfaceEl && event.propertyName === 'transform') settleOpen();
  };

  createEffect(() => {
    const open = nowPlayingOpen();
    const activeAuto = open && auto();
    if (typeof document !== 'undefined') {
      // Which surface is up, not just whether it is Auto. The surface is a
      // portal onto <body> at full viewport with an opaque base, so once it has
      // finished opening the entire app shell behind it is unreachable and
      // unseen — and app.css uses this to stop rendering it. Auto keeps its own
      // value because it also owns the blurred handoff.
      if (open) document.documentElement.dataset.playerSurface = activeAuto ? 'auto' : 'now-playing';
      else delete document.documentElement.dataset.playerSurface;
    }
    if (open && !wasOpen) {
      // Reopening mid-exit: drop the exit animation before it can fight the
      // entrance, and land on the stage card.
      endClose();
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPanel('stage');
      setSurfaceAnimating(true);
      setSurfaceSettled(false);
      clearOpenSettle();
      const reduced = prefersReducedMotion();
      if (surfaceEl) surfaceEl.addEventListener('transitionend', onOpenTransitionEnd);
      openTimer = window.setTimeout(settleOpen, reduced ? 0 : 340);
    } else if (!open && wasOpen) {
      clearOpenSettle();
      setSurfaceSettled(false);
      setSurfaceAnimating(true);
      beginClose();
    }
    wasOpen = open;
  });

  /* The exit is a keyframe, not a transition. A transition needs the browser to
     observe both the before and after value, and it loses to the inline
     transform the swipe leaves behind; an animation is immune to both, so the
     surface slides out even when a gesture or a layout flush lands mid-close. */
  const beginClose = () => {
    const exit = pendingExit ?? { from: 0, duration: EXIT_DURATION };
    pendingExit = null;
    if (surfaceEl) {
      surfaceEl.style.setProperty('--surface-exit-from', `${exit.from}px`);
      surfaceEl.style.setProperty('--surface-exit-duration', `${exit.duration}ms`);
    }
    setClosing(true);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(endClose, exit.duration + CLOSE_ANIMATION_GRACE);
    surfaceEl?.addEventListener('animationend', onCloseAnimationEnd);
  };

  const onCloseAnimationEnd = (event: AnimationEvent) => {
    // Children animate too (the backdrop drifts on a loop); only the surface's
    // own exit ends the close.
    if (event.target === surfaceEl) endClose();
  };

  const endClose = () => {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
    surfaceEl?.removeEventListener('animationend', onCloseAnimationEnd);
    surfaceEl?.style.removeProperty('--surface-exit-from');
    surfaceEl?.style.removeProperty('--surface-exit-duration');
    // Untracked: the open/close effect calls this, and taking a dependency on
    // `closing` there would make it re-run on its own state change.
    if (!untrack(closing)) return;
    setClosing(false);
    setSurfaceAnimating(false);
    // Reset while the surface is off screen so reopening never reveals the
    // previous carousel card during a smooth snap back to the player.
    setPanel('stage');
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!untrack(nowPlayingOpen)) restoreFocus?.focus({ preventScroll: true });
      });
    } else if (!untrack(nowPlayingOpen)) {
      restoreFocus?.focus({ preventScroll: true });
    }
  };

  /**
   * Claim or release the close gesture.
   *
   * Mirrored onto <html> because app.css stops rendering the app shell while the
   * surface is up, and a drag uncovers it a few pixels at a time — the shell has
   * to be back before the surface moves at all, or the gap behind it is blank.
   */
  const setSwiping = (on: boolean) => {
    if (surfaceEl) {
      if (on) surfaceEl.dataset.swiping = '';
      else delete surfaceEl.dataset.swiping;
    }
    if (typeof document === 'undefined') return;
    if (on) document.documentElement.dataset.playerSwiping = '';
    else delete document.documentElement.dataset.playerSwiping;
  };

  /**
   * Close the surface, continuing whatever movement brought it here.
   *
   * `fromY` is the offset the sheet is already at and `velocity` the speed it
   * had (px/ms, downward) when the finger left — both zero for the close button,
   * which starts the travel from rest. The exit covers the distance that is
   * actually left, in the time that distance is worth: a sheet released halfway
   * down does not restart a full-height animation, and a flick keeps its speed
   * instead of dropping into a slow settle. The floor is what stops a release
   * near the bottom from finishing in a single frame — which is the whole
   * complaint: an exit too short to see is an exit nobody believes happened.
   */
  const closeSurface = (fromY = 0, velocity = 0) => {
    if (!nowPlayingOpen()) return;
    // Measured first, on purpose: this is a forced layout, and it has to land
    // while the drag flags are still up. Between dropping `data-player-swiping`
    // and dropping `data-player-surface` the app shell is momentarily styled
    // hidden, and a flush in that gap is the one way it could be seen.
    const height = surfaceEl?.getBoundingClientRect().height || window.innerHeight || 1;
    const from = Math.min(Math.max(0, fromY), height);
    const remaining = height - from;
    const paced = velocity > 0 ? remaining / velocity : Number.POSITIVE_INFINITY;
    const scaled = Math.min(EXIT_DURATION * (remaining / height), paced);
    pendingExit = { from, duration: Math.max(EXIT_DURATION_MIN, Math.round(scaled)) };
    if (surfaceEl) {
      // Synchronously, before `.open` goes: an inline transform left over from
      // the gesture would otherwise outrank the exit for a frame.
      setSwiping(false);
      surfaceEl.style.transform = '';
    }
    setNowPlayingOpen(false);
  };

  const showNowPlaying = () => {
    if (auto()) player().actions.exitAutoMode();
    setPanel('stage');
  };

  const showAuto = () => {
    if (!autoAvailable() || auto()) return;
    player().actions.enterAutoMode();
  };

  /** Arrow keys, Home and End walk the mode tabs without choosing one. */
  const moveModeFocus = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
    const from = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0 || tabs.length === 0) return;
    const to = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (from + 1) % tabs.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (from - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : -1;
    if (to < 0) return;
    event.preventDefault();
    tabs[to].focus();
  };

  /** Docked beside the app, or over all of it. */
  const togglePresentation = () => setPlayerPresentation(playerPresentation() === 'docked' ? 'full' : 'docked');

  /** Drag the docked column's left edge to give it more room or less. */
  const startDockResize = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setPlayerDockWidth(window.innerWidth - next.clientX);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      delete document.documentElement.dataset.playerResizing;
    };
    document.documentElement.dataset.playerResizing = '';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  let dockEdgeEl: HTMLDivElement | undefined;
  const resizeDockByKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setPlayerDockWidth(playerDockWidth() + (event.key === 'ArrowLeft' ? DOCK_KEY_STEP : -DOCK_KEY_STEP));
  };

  /** Drop the gesture and every trace of it. Every bail-out goes through here:
      a leftover `data-swiping` pins `transition: none` on the surface forever. */
  const resetSwipe = () => {
    touchMove?.release();
    swipeStart = null;
    swipeActive = false;
    setSwiping(false);
    if (!surfaceEl) return;
    surfaceEl.style.transform = '';
  };

  const beginTouch = (event: TouchEvent) => {
    resetSwipe();
    // A docked column is closed from its header, never dragged off.
    if (!nowPlayingOpen() || docked() || event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(SWIPE_EXCLUDED)) return;
    const touch = event.touches.item(0);
    if (!touch) return;
    // Resolved once: walking the ancestors with getComputedStyle on every move
    // is a layout read per frame, mid-gesture.
    const scroller = scrollableAncestor(event.target, surfaceEl);
    if (scroller && scroller.scrollTop > 1) return;
    swipeStart = { x: touch.clientX, y: touch.clientY, at: performance.now(), id: touch.identifier, scroller };
    swipeActive = false;
    touchMove?.arm();
  };

  const touchById = (touches: TouchList) => {
    if (!swipeStart) return null;
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === swipeStart.id) return touch;
    }
    return null;
  };

  const moveTouch = (event: TouchEvent) => {
    if (event.touches.length !== 1) { resetSwipe(); return; }
    if (!swipeStart || !surfaceEl) return;
    const touch = touchById(event.touches);
    if (!touch) return;
    const dx = touch.clientX - swipeStart.x;
    const dy = touch.clientY - swipeStart.y;
    if (!swipeActive) {
      // The browser hands the touch to the nearest scroller the moment it sees
      // an unprevented move, and every preventDefault after that is a silent
      // no-op. So the first move that clearly reads as a downward drag has to
      // claim the gesture outright — waiting for 8px was already too late.
      if (Math.abs(dx) > Math.abs(dy)) {
        if (Math.abs(dx) > HORIZONTAL_CANCEL_THRESHOLD) resetSwipe();
        return;
      }
      if (dy < -SWIPE_ACTIVATE_THRESHOLD) {
        // Upward: this belongs to the list, not to us.
        resetSwipe();
        return;
      }
      if (dy <= SWIPE_ACTIVATE_THRESHOLD || dy <= Math.abs(dx) * SWIPE_VERTICAL_BIAS) return;
      if (swipeStart.scroller && swipeStart.scroller.scrollTop > 1) {
        resetSwipe();
        return;
      }
      swipeActive = true;
      setSwiping(true);
    }
    if (event.cancelable) event.preventDefault();
    surfaceEl.style.transform = `translateY(${Math.max(0, dy)}px)`;
  };

  const finishSwipe = (event: TouchEvent) => {
    if (!swipeStart || !surfaceEl) return;
    const touch = touchById(event.changedTouches);
    if (!touch) return;
    const dy = touch.clientY - swipeStart.y;
    const elapsed = Math.max(1, performance.now() - swipeStart.at);
    const velocity = dy / elapsed;
    const close = swipeActive
      && (dy > SWIPE_CLOSE_THRESHOLD || (dy > SWIPE_FAST_CLOSE_THRESHOLD && velocity > SWIPE_CLOSE_VELOCITY));
    resetSwipe();
    // Hand the exit the offset and the speed the finger let go at, so the
    // surface carries on from where it was instead of snapping back up first.
    if (close) closeSurface(Math.max(0, dy), Math.max(0, velocity));
  };

  const cancelSwipe = () => {
    resetSwipe();
  };

  onMount(() => {
    if (!surfaceEl) return;
    // The surface measures itself: its own width, not the window's, decides
    // between the one-panel and the side-by-side composition.
    const measure = () => setPlayerCompact((surfaceEl?.getBoundingClientRect().width || window.innerWidth) < PLAYER_COMPACT_BELOW);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(surfaceEl);
    measure();
    touchMove = createTouchMoveLease(surfaceEl, moveTouch);
    surfaceEl.addEventListener('touchstart', beginTouch, { passive: true });
    surfaceEl.addEventListener('touchend', finishSwipe, { passive: true });
    surfaceEl.addEventListener('touchcancel', cancelSwipe, { passive: true });
    // Capture phase runs after OverlayOutlet (menus/dialogs claim Escape first)
    // and before the global bubble shortcut handler (which closes the player).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && nowPlayingOpen() && compactLyrics()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCompactLyrics();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    onCleanup(() => {
      window.clearTimeout(openTimer);
      window.clearTimeout(focusTimer);
      window.clearTimeout(closeTimer);
      window.removeEventListener('keydown', onKeyDown, true);
      observer?.disconnect();
      delete document.documentElement.dataset.playerDocked;
      document.documentElement.style.removeProperty('--player-dock-width');
      surfaceEl?.removeEventListener('transitionend', onOpenTransitionEnd);
      surfaceEl?.removeEventListener('animationend', onCloseAnimationEnd);
      surfaceEl?.removeEventListener('touchstart', beginTouch);
      touchMove?.release();
      surfaceEl?.removeEventListener('touchend', finishSwipe);
      surfaceEl?.removeEventListener('touchcancel', cancelSwipe);
      delete document.documentElement.dataset.playerSurface;
      delete document.documentElement.dataset.playerSwiping;
    });
  });

  // The app makes room for a docked player (app.module.css) and stays in use
  // beside it (app.css): both read these off the root.
  createEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (nowPlayingOpen() && docked()) root.dataset.playerDocked = '';
    else delete root.dataset.playerDocked;
    root.style.setProperty('--player-dock-width', `${playerDockWidth()}px`);
  });

  return (
    <Portal mount={typeof document !== 'undefined' ? document.body : undefined}>
      {/* `data-player-stage` hands the whole room its material palette: the
          wallpaper filter, the glass, the lines and the rails all come from the
          --stage-* tokens, which flip with the theme (tokens.css). Now Playing,
          Auto and the browser panel are descendants, so they inherit it. */}
      <div
        ref={surfaceEl}
        classList={{
          [styles.surface]: true,
          [styles.open]: nowPlayingOpen(),
          [styles.closing]: closing() && !nowPlayingOpen(),
          [styles.auto]: auto(),
        }}
        data-player-surface-open={nowPlayingOpen() ? '' : undefined}
        data-docked={docked() ? '' : undefined}
        data-compact={playerCompact() ? '' : undefined}
        data-surface-animating={surfaceAnimating() ? '' : undefined}
        data-remote={player().remote ? '' : undefined}
        data-player-stage=""
        aria-hidden={!nowPlayingOpen()}
        tabIndex={-1}
      >
        <Show when={docked()}>
          <div
            ref={dockEdgeEl}
            class={styles.dockEdge}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('nowPlaying.resizeDock')}
            aria-valuemin={DOCK_WIDTH.min}
            aria-valuemax={playerDockMaxWidth()}
            aria-valuenow={playerDockWidth()}
            onPointerDown={startDockResize}
            onKeyDown={resizeDockByKey}
            onDblClick={() => setPlayerDockWidth(DOCK_WIDTH.default)}
          />
        </Show>
        <ArtworkBackdrop class={styles.backdrop} activeClass={styles.backdropActive}
          src={backdrops().first} active={backdrops().active === 'first'} visible={pageVisible() && (nowPlayingOpen() || closing())} />
        <ArtworkBackdrop class={styles.backdrop} activeClass={styles.backdropActive}
          src={backdrops().second} active={backdrops().active === 'second'} visible={pageVisible() && (nowPlayingOpen() || closing())} />
        <div class={styles.wash} data-player-veil="" aria-hidden="true" />
        <div class={styles.grain} aria-hidden="true" />

        <div class={styles.floatingChrome} data-no-surface-swipe="">
          <div class={styles.chromeLeft}>
            <Control
              class={styles.deviceButton}
              classList={{ [styles.deviceButtonActive]: player().remote, [styles.deviceButtonError]: player().unreachable }}
              aria-label={connectLabel()}
              title={connectLabel()}
              data-device-trigger="player-header"
              onClick={openConnect}
            >
              <OutputDeviceIcon size={18} />
              <Show when={player().remote}>
                <span class={styles.deviceButtonLabel}>{connectLabel()}</span>
              </Show>
            </Control>
            {/* Sits in the reserved second chromeLeft slot beside the device button
                so it stays in the top bar without overlapping PlayerMiniHeader. */}
            <Show when={docked() && playerDockWidthCustom()}>
              <SeamReset
                class={styles.dockReset}
                label={t('nowPlaying.resetDock')}
                onReset={() => {
                  setPlayerDockWidth(DOCK_WIDTH.default);
                  dockEdgeEl?.focus({ preventScroll: true });
                }}
              />
            </Show>
          </div>

          {/* Choosing a mode starts or ends DJ, so the arrows only move focus
            * between the two (manual activation); Enter, Space or a click
            * makes the choice. Only the chosen one is in the Tab order. */}
          <div class={styles.modePill} role="tablist" aria-label={t('nowPlaying.modeSelector')} onKeyDown={moveModeFocus}>
            <button
              id="now-playing-mode-normal"
              classList={{ [styles.modeOption]: true, [styles.modeSelected]: !auto() }}
              type="button"
              role="tab"
              aria-selected={!auto()}
              aria-controls="now-playing-view"
              tabIndex={auto() && autoAvailable() ? -1 : 0}
              onClick={showNowPlaying}
            >
              {t('nowPlaying.modeLabel')}
            </button>
            <button
              id="now-playing-mode-dj"
              classList={{ [styles.modeOption]: true, [styles.modeSelected]: auto() }}
              type="button"
              role="tab"
              aria-selected={auto()}
              aria-controls="auto-mode-view"
              tabIndex={auto() ? 0 : -1}
              disabled={!autoAvailable()}
              onClick={showAuto}
            >
              {t('autoMode.label')}
              <span class={styles.betaTag} aria-hidden="true">BETA</span>
            </button>
          </div>

          <div class={styles.chromeRight}>
            <Show when={desktopShell()}>
              <button
                class={styles.chromeButton}
                type="button"
                aria-label={t(playerPresentation() === 'docked' ? 'nowPlaying.fillScreen' : 'nowPlaying.dockBeside')}
                title={t(playerPresentation() === 'docked' ? 'nowPlaying.fillScreen' : 'nowPlaying.dockBeside')}
                onClick={togglePresentation}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <Show when={playerPresentation() === 'docked'} fallback={<path d="M9 4v5H4m11-5v5h5M4 15h5v5m11-5h-5v5" />}>
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                  </Show>
                </svg>
              </button>
            </Show>
            <button
              class={styles.chromeButton}
              type="button"
              aria-label={t('common.close')}
              onClick={() => closeSurface()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <path d={docked() ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'} />
              </svg>
            </button>
          </div>
        </div>

        {/* The phone header has no room for the device's name: it gets a line of its own. */}
        <Show when={playerCompact() && player().remote}>
          <Control
            class={styles.remoteBanner}
            classList={{ [styles.deviceButtonError]: player().unreachable }}
            data-no-surface-swipe=""
            data-device-trigger="player-banner"
            onClick={openConnect}
          >
            <OutputDeviceIcon size={14} />
            <span class={styles.deviceButtonLabel}>{connectLabel()}</span>
          </Control>
        </Show>

        <div
          id="now-playing-view"
          classList={{ [styles.view]: true, [styles.viewActive]: !auto() && !compactLyrics() }}
          role="tabpanel"
          aria-labelledby="now-playing-mode-normal"
          aria-hidden={auto() || !nowPlayingOpen() || compactLyrics()}
          inert={auto() || !nowPlayingOpen() || compactLyrics() ? true : undefined}
        >
          <Show when={opened()}>
            <NowPlaying
              mobilePanel={mobilePanel() as NowPlayingMobilePanel}
              onMobilePanelChange={setPanel}
              surfaceOpen={nowPlayingOpen() && !auto() && !compactLyrics()}
              panelsReady={surfaceSettled()}
              onCloseSurface={() => closeSurface()}
            />
          </Show>
        </div>

        <div
          id="auto-mode-view"
          classList={{ [styles.view]: true, [styles.viewActive]: auto() && !compactLyrics() }}
          role="tabpanel"
          aria-labelledby="now-playing-mode-dj"
          aria-hidden={!auto() || !nowPlayingOpen() || compactLyrics()}
          inert={!auto() || !nowPlayingOpen() || compactLyrics() ? true : undefined}
        >
          <Show when={auto()}>
            <AutoMode
              panel={mobilePanel() as AutoModePanelId}
              onPanelChange={setPanel}
              surfaceOpen={nowPlayingOpen() && auto() && !compactLyrics()}
              panelsReady={surfaceSettled()}
            />
          </Show>
        </div>

        <Show when={opened() && playerCompact() && compactLyrics()}>
          <section
            class={styles.compactLyricsView}
            aria-label={t('nowPlaying.lyricsLabel')}
            data-compact-lyrics=""
          >
            <PlayerMiniHeader mode={auto() ? 'auto' : 'now-playing'} onBack={closeCompactLyrics} />
            <div class={styles.compactLyricsBody}>
              <Suspense fallback={
                <div class={styles.lyricsPending}>
                  <Spinner size={22} label={t('lyricsPanel.loading')} />
                </div>
              }>
                <CompactLyrics />
              </Suspense>
            </div>
          </section>
        </Show>

        <Show when={playerCompact() && (current() || auto())}>
          <PlayerCompactDock
            auto={auto()}
            hasTrack={Boolean(current())}
            podcast={podcast()}
            lyricsActive={compactLyrics()}
            listActive={!compactLyrics() && isListPanel()}
            listCount={listCount()}
            surfaceOpen={nowPlayingOpen()}
            onToggleLyrics={toggleCompactLyrics}
            onToggleList={toggleListPanel}
            lyricsButtonRef={(element) => { lyricsToggleEl = element; }}
          />
        </Show>
      </div>
    </Portal>
  );
}
