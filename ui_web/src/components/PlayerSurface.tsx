import { createEffect, createMemo, createSignal, For, lazy, onCleanup, onMount, Show, Suspense, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { actions, nowPlayingOpen, setNowPlayingOpen, state } from '../stores';
import { coverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { AUTO_MODE_PANELS, type AutoModePanelId } from '../lib/autoModeLayout';
import { NowPlaying, type NowPlayingMobilePanel } from './NowPlaying';
import styles from './PlayerSurface.module.css';

const AutoMode = lazy(() => import('./AutoMode').then((module) => ({ default: module.AutoMode })));

const MOBILE_QUERY = '(max-width: 1023px)';
const SWIPE_CLOSE_THRESHOLD = 80;
const SWIPE_FAST_CLOSE_THRESHOLD = 32;
const SWIPE_CLOSE_VELOCITY = 0.45;
const SWIPE_ACTIVATE_THRESHOLD = 2;
const HORIZONTAL_CANCEL_THRESHOLD = 6;
/** How much taller than wide a drag must be before it counts as a close. */
const SWIPE_VERTICAL_BIAS = 1.5;
const CLOSE_ANIMATION_TIMEOUT = 420;
/* Controls that own the touch themselves. Plain buttons are deliberately absent:
   in the mobile layout the queue rows and the browser cards *are* full-width
   buttons, so excluding them left most of the surface unswipeable. A tap never
   activates the gesture, and once it does the browser cancels the click. */
const SWIPE_EXCLUDED = 'input, textarea, select, [data-rail], [data-lyrics-scroll], [data-no-surface-swipe]';
const NOW_PLAYING_PANELS = ['browser', 'stage', 'queue'] as const;
type PlayerPanel = NowPlayingMobilePanel | AutoModePanelId;

type BackdropState = {
  first: string;
  second: string;
  active: 'first' | 'second';
};

/** Nearest scrolling ancestor below `boundary`, or null when there is none. */
function scrollableAncestor(target: EventTarget | null, boundary?: HTMLElement): HTMLElement | null {
  let element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  while (element && element !== boundary) {
    const style = getComputedStyle(element);
    if (
      /(auto|scroll)/.test(style.overflowY)
      && element.scrollHeight > element.clientHeight + 1
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

/** One fullscreen player environment shared by Now Playing and Auto Mode. */
export function PlayerSurface() {
  const current = createMemo(() => state.playback.currentTrack);
  const auto = createMemo(() => state.autoMode.active);
  const autoAvailable = createMemo(() => !current() || !isPodcastTrack(current()!));
  const art = createMemo(() => {
    const track = current();
    return track ? track.cover ?? coverUrl(track.id) : '';
  });
  const [mobilePanel, setMobilePanel] = createSignal<PlayerPanel>('stage');
  /* Fractional carousel position, fed by the scroller itself. The pager marker
     follows it live; `mobilePanel` keeps the settled semantics (inert, focus). */
  const [carouselProgress, setCarouselProgress] = createSignal(1);
  const [carouselLive, setCarouselLive] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [mobileLayout, setMobileLayout] = createSignal(
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(MOBILE_QUERY).matches,
  );
  const [backdrops, setBackdrops] = createSignal<BackdropState>({
    first: art(),
    second: '',
    active: 'first',
  });
  let surfaceEl: HTMLDivElement | undefined;
  let restoreFocus: HTMLElement | null = null;
  let wasOpen = false;
  let wasAuto = auto();
  let swipeStart: { x: number; y: number; at: number; id: number; scroller: HTMLElement | null } | null = null;
  let swipeActive = false;
  let closeTimer: number | undefined;

  createEffect(() => {
    const next = art();
    const currentState = backdrops();
    const visible = currentState.active === 'first' ? currentState.first : currentState.second;
    if (next === visible) return;
    setBackdrops((value) => value.active === 'first'
      ? { ...value, second: next, active: 'second' }
      : { ...value, first: next, active: 'first' });
  });

  const panels = createMemo<readonly PlayerPanel[]>(() => auto() ? AUTO_MODE_PANELS : NOW_PLAYING_PANELS);
  const setPanel = (panel: PlayerPanel) => {
    setMobilePanel(panel);
    setCarouselLive(false);
    setCarouselProgress(panels().indexOf(panel));
  };

  createEffect(() => {
    const active = auto();
    requestAnimationFrame(() => {
      if (!surfaceEl) return;
      surfaceEl.scrollLeft = 0;
      surfaceEl.scrollTop = 0;
    });
    if (active && !wasAuto) {
      setNowPlayingOpen(true);
      setPanel('stage');
    }
    if (!active && wasAuto) setPanel('stage');
    wasAuto = active;
  });

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
      requestAnimationFrame(() => surfaceEl?.focus({ preventScroll: true }));
    } else if (!open && wasOpen) {
      beginClose();
      requestAnimationFrame(() => restoreFocus?.focus({ preventScroll: true }));
    }
    wasOpen = open;
  });

  /* The exit is a keyframe, not a transition. A transition needs the browser to
     observe both the before and after value, and it loses to the inline
     transform the swipe leaves behind; an animation is immune to both, so the
     surface slides out even when a gesture or a layout flush lands mid-close. */
  const beginClose = () => {
    setClosing(true);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(endClose, CLOSE_ANIMATION_TIMEOUT);
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
    // Untracked: the open/close effect calls this, and taking a dependency on
    // `closing` there would make it re-run on its own state change.
    if (!untrack(closing)) return;
    setClosing(false);
    // Reset while the surface is off screen so reopening never reveals the
    // previous carousel card during a smooth snap back to the player.
    setPanel('stage');
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

  const closeSurface = (fromY = 0) => {
    if (!nowPlayingOpen()) return;
    if (surfaceEl) {
      // Synchronously, before `.open` goes: an inline transform left over from
      // the gesture would otherwise outrank the exit for a frame.
      setSwiping(false);
      surfaceEl.style.transform = '';
      surfaceEl.style.setProperty('--surface-exit-from', `${Math.max(0, fromY)}px`);
    }
    setNowPlayingOpen(false);
  };

  const showNowPlaying = () => {
    if (auto()) actions.exitAutoMode();
    setPanel('stage');
  };

  const showAuto = () => {
    if (!autoAvailable() || auto()) return;
    actions.enterAutoMode();
  };

  const browserAction = () => {
    if (auto()) actions.exitAutoMode();
    setPanel('browser');
  };

  /** Drop the gesture and every trace of it. Every bail-out goes through here:
      a leftover `data-swiping` pins `transition: none` on the surface forever. */
  const resetSwipe = () => {
    swipeStart = null;
    swipeActive = false;
    setSwiping(false);
    if (!surfaceEl) return;
    surfaceEl.style.transform = '';
  };

  const beginTouch = (event: TouchEvent) => {
    resetSwipe();
    if (!nowPlayingOpen() || event.touches.length !== 1) return;
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
        if (Math.abs(dx) > HORIZONTAL_CANCEL_THRESHOLD) swipeStart = null;
        return;
      }
      if (dy < -SWIPE_ACTIVATE_THRESHOLD) {
        // Upward: this belongs to the list, not to us.
        swipeStart = null;
        return;
      }
      if (dy <= SWIPE_ACTIVATE_THRESHOLD || dy <= Math.abs(dx) * SWIPE_VERTICAL_BIAS) return;
      if (swipeStart.scroller && swipeStart.scroller.scrollTop > 1) {
        swipeStart = null;
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
    // Hand the exit the offset the finger let go at, so the surface carries on
    // from where it was instead of snapping back up first.
    if (close) closeSurface(dy);
  };

  const cancelSwipe = () => {
    resetSwipe();
  };

  onMount(() => {
    if (!surfaceEl) return;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null;
    const syncLayout = () => setMobileLayout(Boolean(media?.matches));
    media?.addEventListener('change', syncLayout);
    syncLayout();
    surfaceEl.addEventListener('touchstart', beginTouch, { passive: true });
    surfaceEl.addEventListener('touchmove', moveTouch, { passive: false });
    surfaceEl.addEventListener('touchend', finishSwipe, { passive: true });
    surfaceEl.addEventListener('touchcancel', cancelSwipe, { passive: true });
    onCleanup(() => {
      window.clearTimeout(closeTimer);
      media?.removeEventListener('change', syncLayout);
      surfaceEl?.removeEventListener('animationend', onCloseAnimationEnd);
      surfaceEl?.removeEventListener('touchstart', beginTouch);
      surfaceEl?.removeEventListener('touchmove', moveTouch);
      surfaceEl?.removeEventListener('touchend', finishSwipe);
      surfaceEl?.removeEventListener('touchcancel', cancelSwipe);
      delete document.documentElement.dataset.playerSurface;
      delete document.documentElement.dataset.playerSwiping;
    });
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
        data-player-stage=""
        aria-hidden={!nowPlayingOpen()}
        tabIndex={-1}
      >
        <div
          classList={{ [styles.backdrop]: true, [styles.backdropActive]: backdrops().active === 'first' }}
          style={{ 'background-image': backdrops().first ? `url("${backdrops().first}")` : undefined }}
          aria-hidden="true"
        />
        <div
          classList={{ [styles.backdrop]: true, [styles.backdropActive]: backdrops().active === 'second' }}
          style={{ 'background-image': backdrops().second ? `url("${backdrops().second}")` : undefined }}
          aria-hidden="true"
        />
        <div class={styles.wash} aria-hidden="true" />
        <div class={styles.grain} aria-hidden="true" />

        <div class={styles.floatingChrome} data-no-surface-swipe="">
          <Show when={mobileLayout() && !auto()}>
            <button
              classList={{ [styles.chromeButton]: true, [styles.browserButton]: true }}
              type="button"
              aria-label={t('nowPlaying.openSearch')}
              title={t('nowPlaying.openSearch')}
              onClick={browserAction}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="5.5" />
                <path d="m15 15 4 4" />
              </svg>
            </button>
          </Show>

          <div class={styles.modePill} role="tablist" aria-label={t('nowPlaying.modeSelector')}>
            <button
              classList={{ [styles.modeOption]: true, [styles.modeSelected]: !auto() }}
              type="button"
              role="tab"
              aria-selected={!auto()}
              aria-controls="now-playing-view"
              onClick={showNowPlaying}
            >
              {t('nowPlaying.modeLabel')}
            </button>
            <button
              classList={{ [styles.modeOption]: true, [styles.modeSelected]: auto() }}
              type="button"
              role="tab"
              aria-selected={auto()}
              aria-controls="auto-mode-view"
              disabled={!autoAvailable()}
              onClick={showAuto}
            >
              {t('autoMode.label')}
            </button>
          </div>

          <button
            classList={{ [styles.chromeButton]: true, [styles.closeButton]: true }}
            type="button"
            aria-label={t('common.close')}
            onClick={() => closeSurface()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        <div
          id="now-playing-view"
          classList={{ [styles.view]: true, [styles.viewActive]: !auto() }}
          role="tabpanel"
          aria-hidden={auto() || !nowPlayingOpen()}
          inert={auto() || !nowPlayingOpen() ? true : undefined}
        >
          <NowPlaying
            mobilePanel={mobilePanel() as NowPlayingMobilePanel}
            onMobilePanelChange={setPanel}
            onCarouselProgress={(index, live) => {
              setCarouselLive(live);
              setCarouselProgress(index);
            }}
            surfaceOpen={nowPlayingOpen()}
            onCloseSurface={() => closeSurface()}
          />
        </div>

        <div
          id="auto-mode-view"
          classList={{ [styles.view]: true, [styles.viewActive]: auto() }}
          role="tabpanel"
          aria-hidden={!auto() || !nowPlayingOpen()}
          inert={!auto() || !nowPlayingOpen() ? true : undefined}
        >
          <Show when={auto()}>
            <Suspense fallback={<div class={styles.autoLoading} aria-hidden="true" />}>
              <AutoMode
                panel={mobilePanel() as AutoModePanelId}
                onPanelChange={setPanel}
                onCarouselProgress={(index, live) => {
                  setCarouselLive(live);
                  setCarouselProgress(index);
                }}
                surfaceOpen={nowPlayingOpen()}
              />
            </Suspense>
          </Show>
        </div>

        <nav
          class={styles.carouselNav}
          aria-label={auto() ? t('autoMode.mobile.controls') : t('nowPlaying.mobilePanels')}
          data-no-surface-swipe=""
          data-live={carouselLive() ? '' : undefined}
          style={`--carousel-index: ${carouselProgress()}`}
        >
          <span class={styles.carouselMarker} aria-hidden="true" />
          <For each={panels()}>
            {(panel, index) => (
              <button
                type="button"
                classList={{
                  [styles.carouselDot]: true,
                  // Visually the dot follows the scroll, so it clears the moment
                  // the marker covers it; `aria-current` waits for the settle.
                  [styles.carouselDotActive]: Math.round(carouselProgress()) === index(),
                }}
                aria-label={auto() ? t(`autoMode.panel.${panel}`) : t(`nowPlaying.panel.${panel}`)}
                aria-current={mobilePanel() === panel ? 'page' : undefined}
                onClick={() => setPanel(panel)}
              />
            )}
          </For>
        </nav>
      </div>
    </Portal>
  );
}
