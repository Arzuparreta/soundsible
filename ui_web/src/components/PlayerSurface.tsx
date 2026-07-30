import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { actions, nowPlayingOpen, setNowPlayingOpen, state } from '../stores';
import { coverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { AutoMode } from './AutoMode';
import { NowPlaying, type NowPlayingMobilePanel } from './NowPlaying';
import { browserOpen, openBrowser, toggleBrowser } from './NowPlayingBrowser';
import styles from './PlayerSurface.module.css';

const MOBILE_QUERY = '(max-width: 1023px)';
const SWIPE_CLOSE_THRESHOLD = 80;
const SWIPE_FAST_CLOSE_THRESHOLD = 32;
const SWIPE_CLOSE_VELOCITY = 0.45;
const SWIPE_ACTIVATE_THRESHOLD = 8;
const HORIZONTAL_CANCEL_THRESHOLD = 12;

type BackdropState = {
  first: string;
  second: string;
  active: 'first' | 'second';
};

function scrollableAtTop(target: EventTarget | null, boundary?: HTMLElement): boolean {
  let element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  while (element && element !== boundary) {
    const style = getComputedStyle(element);
    if (
      /(auto|scroll)/.test(style.overflowY)
      && element.scrollHeight > element.clientHeight + 1
    ) {
      return element.scrollTop <= 1;
    }
    element = element.parentElement;
  }
  return true;
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
  const [mobilePanel, setMobilePanel] = createSignal<NowPlayingMobilePanel>('stage');
  const [backdrops, setBackdrops] = createSignal<BackdropState>({
    first: art(),
    second: '',
    active: 'first',
  });
  let surfaceEl: HTMLDivElement | undefined;
  let restoreFocus: HTMLElement | null = null;
  let wasOpen = false;
  let wasAuto = auto();
  let swipeStart: { x: number; y: number; at: number; id: number } | null = null;
  let swipeActive = false;

  createEffect(() => {
    const next = art();
    const currentState = backdrops();
    const visible = currentState.active === 'first' ? currentState.first : currentState.second;
    if (next === visible) return;
    setBackdrops((value) => value.active === 'first'
      ? { ...value, second: next, active: 'second' }
      : { ...value, first: next, active: 'first' });
  });

  createEffect(() => {
    const active = auto();
    if (active && !wasAuto) {
      setNowPlayingOpen(true);
      setMobilePanel('stage');
    }
    if (!active && wasAuto) setMobilePanel('stage');
    wasAuto = active;
  });

  createEffect(() => {
    const open = nowPlayingOpen();
    const activeAuto = open && auto();
    if (typeof document !== 'undefined') {
      if (activeAuto) document.documentElement.dataset.playerSurface = 'auto';
      else delete document.documentElement.dataset.playerSurface;
    }
    if (open && !wasOpen) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMobilePanel('stage');
      requestAnimationFrame(() => surfaceEl?.focus({ preventScroll: true }));
    } else if (!open && wasOpen) {
      requestAnimationFrame(() => restoreFocus?.focus({ preventScroll: true }));
    }
    wasOpen = open;
  });

  const closeSurface = () => setNowPlayingOpen(false);

  const showNowPlaying = () => {
    if (auto()) actions.exitAutoMode();
    setMobilePanel('stage');
  };

  const showAuto = () => {
    if (!autoAvailable() || auto()) return;
    actions.enterAutoMode();
  };

  const browserActionLabel = () =>
    !auto() && browserOpen()
      ? t('nowPlaying.hideSearchPanel')
      : t('nowPlaying.showSearchPanel');

  const browserAction = () => {
    const wasAuto = auto();
    if (wasAuto) actions.exitAutoMode();
    if (window.matchMedia(MOBILE_QUERY).matches) {
      openBrowser();
      setMobilePanel('browser');
      return;
    }
    if (wasAuto) openBrowser();
    else toggleBrowser();
  };

  const beginTouch = (event: TouchEvent) => {
    if (!nowPlayingOpen() || event.touches.length !== 1) {
      swipeStart = null;
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, input, textarea, select, [data-rail], [data-lyrics-scroll], [data-no-surface-swipe]')) {
      swipeStart = null;
      return;
    }
    const touch = event.touches.item(0);
    if (!touch || !scrollableAtTop(event.target, surfaceEl)) {
      swipeStart = null;
      return;
    }
    swipeStart = { x: touch.clientX, y: touch.clientY, at: performance.now(), id: touch.identifier };
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
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > HORIZONTAL_CANCEL_THRESHOLD) {
        swipeStart = null;
        return;
      }
      if (dy <= SWIPE_ACTIVATE_THRESHOLD) return;
      if (!scrollableAtTop(event.target, surfaceEl)) return;
      swipeActive = true;
      surfaceEl.dataset.swiping = '';
    }
    event.preventDefault();
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
    swipeStart = null;
    swipeActive = false;
    delete surfaceEl.dataset.swiping;
    if (close) closeSurface();
    requestAnimationFrame(() => {
      if (surfaceEl) surfaceEl.style.transform = '';
    });
  };

  const cancelSwipe = () => {
    swipeStart = null;
    swipeActive = false;
    if (!surfaceEl) return;
    delete surfaceEl.dataset.swiping;
    requestAnimationFrame(() => {
      if (surfaceEl) surfaceEl.style.transform = '';
    });
  };

  onMount(() => {
    if (!surfaceEl) return;
    surfaceEl.addEventListener('touchstart', beginTouch, { passive: true });
    surfaceEl.addEventListener('touchmove', moveTouch, { passive: false });
    surfaceEl.addEventListener('touchend', finishSwipe, { passive: true });
    surfaceEl.addEventListener('touchcancel', cancelSwipe, { passive: true });
    onCleanup(() => {
      surfaceEl?.removeEventListener('touchstart', beginTouch);
      surfaceEl?.removeEventListener('touchmove', moveTouch);
      surfaceEl?.removeEventListener('touchend', finishSwipe);
      surfaceEl?.removeEventListener('touchcancel', cancelSwipe);
      delete document.documentElement.dataset.playerSurface;
    });
  });

  return (
    <Portal mount={typeof document !== 'undefined' ? document.body : undefined}>
      <div
        ref={surfaceEl}
        classList={{
          [styles.surface]: true,
          [styles.open]: nowPlayingOpen(),
          [styles.auto]: auto(),
        }}
        data-player-surface-open={nowPlayingOpen() ? '' : undefined}
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
          <button
            classList={{ [styles.chromeButton]: true, [styles.chromeButtonActive]: !auto() && browserOpen() }}
            type="button"
            aria-label={browserActionLabel()}
            title={browserActionLabel()}
            aria-pressed={!auto() && browserOpen()}
            onClick={browserAction}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="5.5" />
              <path d="m15 15 4 4M4 4h16v16H4" opacity=".58" />
            </svg>
          </button>

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

          <button class={styles.chromeButton} type="button" aria-label={t('common.close')} onClick={closeSurface}>
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
            mobilePanel={mobilePanel()}
            onMobilePanelChange={setMobilePanel}
            surfaceOpen={nowPlayingOpen()}
            onCloseSurface={closeSurface}
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
            <AutoMode />
          </Show>
        </div>

        <Show when={!auto()}>
          <nav class={styles.carouselNav} aria-label={t('nowPlaying.mobilePanels')} data-no-surface-swipe="">
            {(['browser', 'stage', 'queue'] as const).map((panel) => (
              <button
                type="button"
                classList={{ [styles.carouselDot]: true, [styles.carouselDotActive]: mobilePanel() === panel }}
                aria-label={t(`nowPlaying.panel.${panel}`)}
                aria-current={mobilePanel() === panel ? 'page' : undefined}
                onClick={() => setMobilePanel(panel)}
              />
            ))}
          </nav>
        </Show>
      </div>
    </Portal>
  );
}
