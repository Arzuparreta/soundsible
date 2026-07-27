import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { AutoActivity, AutoProfile } from '../lib/autopilot';
import styles from './AutoMode.module.css';
import { clockTime } from '../lib/format';

const IDLE_MS = 12_000;

/** A downward drag has to travel this far, this straight, this fast, to exit. */
const SWIPE_MIN_Y = 110;
const SWIPE_MAX_MS = 900;

/** Breathing room the autopilot line keeps from the artwork and the top bar. */
const STATUS_GAP = 12;
const STATUS_MIN_GAP = 6;

/**
 * Type-size tier for a track title.
 *
 * Auto Mode gives the title a fixed two-line well so the artwork above it never
 * resizes between tracks. Long titles therefore have to get *smaller*, not
 * taller — the alternative is what the previous layout did, which was overflow
 * a centred grid item and get clipped at both ends. The thresholds are
 * character counts because that is what the layout actually reacts to, and they
 * are picked so a 90-character title still lands inside two lines at every
 * viewport this screen supports.
 */
export function titleFit(title: string): 'lg' | 'md' | 'sm' | 'xs' {
  const length = title.trim().length;
  if (length <= 20) return 'lg';
  if (length <= 36) return 'md';
  if (length <= 58) return 'sm';
  return 'xs';
}

function translatedValues(values?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' && value.startsWith('autoMode.') ? t(value) : value,
    ]),
  );
}

function activityText(activity: AutoActivity): string {
  return t(activity.key, translatedValues(activity.values));
}

export function AutoMode() {
  const current = createMemo(() => state.playback.currentTrack);
  const active = createMemo(() => state.autoMode.active);
  const [chromeVisible, setChromeVisible] = createSignal(true);
  const [agentVisible, setAgentVisible] = createSignal(false);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let agentTimer: ReturnType<typeof setTimeout> | null = null;
  let rootEl: HTMLDivElement | undefined;
  let topbarEl: HTMLElement | undefined;
  let statusEl: HTMLDivElement | undefined;
  let mobileCover: DOMRect | null = null;
  let swipe: { x: number; y: number; at: number } | null = null;
  let restoreFocus: HTMLElement | null = null;
  let wasActive = false;

  const clearMobileStatusSlot = () => {
    if (!rootEl) return;
    rootEl.removeAttribute('data-mobile-status-above');
    rootEl.style.removeProperty('--auto-mobile-status-top');
  };

  /**
   * On mobile the artwork is pinned to the Now Playing rectangle, so the panel
   * below it is laid out against the cover's *flow* position rather than the one
   * it is actually drawn at — which is how the autopilot line ended up sitting
   * over the bottom edge of the artwork. There is nothing to reclaim below the
   * cover, but the band between the top bar and the pinned cover is empty on
   * every phone, so the line moves up into it. On a viewport where that band is
   * too short the line stays in its reserved slot in the panel: a status line
   * crossing the top bar would be worse than one grazing the cover.
   */
  const placeMobileStatus = () => {
    if (!rootEl || !statusEl || !topbarEl || !mobileCover) return;
    clearMobileStatusSlot();
    const height = statusEl.getBoundingClientRect().height;
    const ceiling = topbarEl.getBoundingClientRect().bottom + STATUS_MIN_GAP;
    const top = Math.max(ceiling, mobileCover.top - STATUS_GAP - height);
    if (height <= 0 || top + height > mobileCover.top - STATUS_MIN_GAP) return;
    rootEl.style.setProperty('--auto-mobile-status-top', `${Math.round(top)}px`);
    rootEl.setAttribute('data-mobile-status-above', '');
  };

  const clearMobileCoverAnchor = () => {
    mobileCover = null;
    if (!rootEl) return;
    rootEl.removeAttribute('data-mobile-cover-anchor');
    rootEl.style.removeProperty('--auto-mobile-cover-left');
    rootEl.style.removeProperty('--auto-mobile-cover-top');
    rootEl.style.removeProperty('--auto-mobile-cover-width');
    rootEl.style.removeProperty('--auto-mobile-cover-height');
    clearMobileStatusSlot();
  };

  const captureMobileCoverAnchor = () => {
    if (!rootEl || typeof window === 'undefined' || window.innerWidth >= 768) {
      clearMobileCoverAnchor();
      return;
    }
    const source = document.querySelector<HTMLElement>('[data-now-playing-cover-slot]');
    const rect = source?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      clearMobileCoverAnchor();
      return;
    }
    mobileCover = rect;
    rootEl.style.setProperty('--auto-mobile-cover-left', `${rect.left}px`);
    rootEl.style.setProperty('--auto-mobile-cover-top', `${rect.top}px`);
    rootEl.style.setProperty('--auto-mobile-cover-width', `${rect.width}px`);
    rootEl.style.setProperty('--auto-mobile-cover-height', `${rect.height}px`);
    rootEl.setAttribute('data-mobile-cover-anchor', '');
    placeMobileStatus();
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    setChromeVisible(true);
    if (!active()) return;
    idleTimer = setTimeout(() => setChromeVisible(false), IDLE_MS);
  };

  createEffect(() => {
    const isActive = active();
    if (typeof document !== 'undefined') {
      if (isActive) document.documentElement.dataset.autoMode = 'active';
      else delete document.documentElement.dataset.autoMode;
    }
    if (isActive && !wasActive) {
      captureMobileCoverAnchor();
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestAnimationFrame(() => rootEl?.focus({ preventScroll: true }));
      armIdle();
    } else if (!isActive && wasActive) {
      requestAnimationFrame(() => restoreFocus?.focus({ preventScroll: true }));
    }
    if (!isActive && idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    wasActive = isActive;
  });

  onMount(() => {
    const syncAnchor = () => {
      if (active()) captureMobileCoverAnchor();
    };
    window.addEventListener('resize', syncAnchor);
    onCleanup(() => window.removeEventListener('resize', syncAnchor));
  });

  createEffect(() => {
    current()?.id;
    if (!active()) return;
    armIdle();
    // The panel only exists while there is a track, so the first one to arrive
    // is the first chance to place the status line above the artwork.
    placeMobileStatus();
  });

  createEffect(() => {
    const activity = state.autoMode.activity;
    if (agentTimer) clearTimeout(agentTimer);
    setAgentVisible(Boolean(activity));
    if (activity && activity.status !== 'working') {
      agentTimer = setTimeout(() => setAgentVisible(false), 6_000);
    }
  });

  onCleanup(() => {
    if (idleTimer) clearTimeout(idleTimer);
    if (agentTimer) clearTimeout(agentTimer);
    clearMobileCoverAnchor();
    if (typeof document !== 'undefined') delete document.documentElement.dataset.autoMode;
  });

  const art = createMemo(() => {
    const track = current();
    return track ? track.cover ?? coverUrl(track.id) : '';
  });
  const upcoming = createMemo(() => state.playback.queue.slice(Math.max(0, state.playback.index + 1)));
  const progress = createMemo(() => {
    const duration = state.playback.duration;
    return duration > 0 ? Math.min(100, (state.playback.currentTime / duration) * 100) : 0;
  });
  const backdropStyle = (): JSX.CSSProperties => {
    const url = art();
    return url ? { 'background-image': `url("${url}")` } : {};
  };

  const cycleProfile = () => {
    const profiles: AutoProfile[] = ['familiar', 'balanced', 'explore'];
    const currentIndex = profiles.indexOf(state.autoMode.profile);
    actions.setAutoProfile(profiles[(currentIndex + 1) % profiles.length]);
    armIdle();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    armIdle();
    if (event.key === 'ArrowUp') actions.setVolume(state.playback.volume + 0.05);
    else if (event.key === 'ArrowDown') actions.setVolume(state.playback.volume - 0.05);
    else if (event.key.toLowerCase() === 'n') void actions.autoSkip();
  };

  return (
    <Portal mount={typeof document !== 'undefined' ? document.body : undefined}>
      <div
        ref={rootEl}
        classList={{ [styles.root]: true, [styles.active]: active(), [styles.ambient]: !chromeVisible() }}
        role="region"
        aria-label={t('autoMode.aria')}
        aria-hidden={!active()}
        data-playing={state.playback.isPlaying ? 'true' : 'false'}
        tabIndex={-1}
        onPointerMove={armIdle}
        onPointerDown={(event) => {
          armIdle();
          // A drag that starts on a control or inside the queue rail belongs to
          // that control. Without this, scrolling the rail — or any drag that
          // happened to travel downwards — exited Auto Mode.
          const target = event.target as HTMLElement | null;
          swipe = target?.closest('button, [data-rail]')
            ? null
            : { x: event.clientX, y: event.clientY, at: event.timeStamp };
        }}
        onPointerUp={(event) => {
          const start = swipe;
          swipe = null;
          if (!start) return;
          const dy = event.clientY - start.y;
          const dx = Math.abs(event.clientX - start.x);
          if (dy > SWIPE_MIN_Y && dx < dy * 0.6 && event.timeStamp - start.at < SWIPE_MAX_MS) {
            actions.exitAutoMode();
          }
        }}
        onPointerCancel={() => {
          swipe = null;
        }}
        onKeyDown={onKeyDown}
      >
        <div class={styles.backdrop} style={backdropStyle()} aria-hidden="true" />
        <div class={styles.wash} aria-hidden="true" />
        <div class={styles.grain} aria-hidden="true" />

        <header class={styles.topbar} ref={topbarEl}>
          <div class={styles.brandBlock}>
            <span class={styles.mark} aria-hidden="true"><i /><i /><i /></span>
            <span class={styles.autoLabel}>{t('autoMode.label')}</span>
          </div>
          <div class={styles.topActions}>
            <button
              class={styles.profile}
              type="button"
              aria-label={t('autoMode.changeProfile', { profile: t(`autoMode.profile.${state.autoMode.profile}`) })}
              onClick={cycleProfile}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" />
              </svg>
              {t(`autoMode.profile.${state.autoMode.profile}`)}
            </button>
            <button class={styles.exit} type="button" aria-label={t('autoMode.exit')} onClick={() => actions.exitAutoMode()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </header>

        <Show when={current()}>
          <main class={styles.stage}>
            <div class={styles.coverStage}>
              <div class={styles.coverFrame}>
                <div class={styles.coverGlow} style={backdropStyle()} aria-hidden="true" />
                <div class={styles.cover} style={backdropStyle()} role="img" aria-label={current()!.title} />
              </div>
            </div>

            <div class={styles.panel}>
              <div class={styles.meta} data-fit={titleFit(current()!.title)} aria-live="polite">
                <div class={styles.titleBox}>
                  <h1 class={styles.title} title={current()!.title}>{current()!.title}</h1>
                </div>
                <p class={styles.artist} title={current()!.artist}>{current()!.artist}</p>
              </div>

              <div class={styles.status} ref={statusEl}>
                <Show when={state.autoMode.activity && agentVisible()}>
                  <div
                    class={styles.agent}
                    data-status={state.autoMode.activity!.status}
                    role="status"
                    aria-live="polite"
                  >
                    <span class={styles.agentPulse} aria-hidden="true" />
                    <span class={styles.agentText}>{activityText(state.autoMode.activity!)}</span>
                  </div>
                </Show>
              </div>

              <div class={styles.controls}>
                <div class={styles.seek}>
                  <span class={styles.time}>{clockTime(state.playback.currentTime)}</span>
                  <div class={styles.progress}>
                    <div class={styles.progressFill} style={{ width: `${progress()}%` }} />
                  </div>
                  <span class={styles.time}>{clockTime(state.playback.duration)}</span>
                </div>
                <div class={styles.transport}>
                  <div class={styles.cluster}>
                    <button type="button" aria-label={t('common.prev')} onClick={() => actions.prev()}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
                    </button>
                    <button class={styles.play} type="button" aria-label={state.playback.isPlaying ? t('common.pause') : t('common.play')} onClick={() => actions.togglePlay()}>
                      <Show when={state.playback.isPlaying} fallback={<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                      </Show>
                    </button>
                    <button type="button" aria-label={t('common.next')} onClick={() => void actions.autoSkip()}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>
                    </button>
                  </div>
                  <div class={styles.extras}>
                    <Show
                      when={current()!.source !== 'preview'}
                      fallback={
                        <button class={styles.secondaryAction} type="button" aria-label={t('nowPlaying.saveToLibrary')} onClick={() => void actions.downloadTrack(current()!)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14" /></svg>
                        </button>
                      }
                    >
                      <button
                        classList={{ [styles.secondaryAction]: true, [styles.liked]: state.favorites.includes(current()!.id) }}
                        type="button"
                        aria-label={state.favorites.includes(current()!.id) ? t('nowPlaying.removeFav') : t('nowPlaying.addFav')}
                        onClick={() => actions.toggleFavourite(current()!.id)}
                      >
                        <svg viewBox="0 0 24 24" fill={state.favorites.includes(current()!.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" /></svg>
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </main>

          <Show when={upcoming().length > 0}>
            <section class={styles.upStrip} aria-label={t('autoMode.upNext')}>
              <span class={styles.upHead}>{t('autoMode.upNext')}</span>
              <div
                class={styles.filmstrip}
                data-rail=""
                tabIndex={0}
                onWheel={(event) => {
                  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
                  event.currentTarget.scrollLeft += event.deltaY;
                  event.preventDefault();
                }}
              >
                <For each={upcoming()}>
                  {(track, index) => {
                    const image = () => track.cover ?? coverUrl(track.id);
                    return (
                      <button
                        class={styles.nextCard}
                        type="button"
                        title={`${track.title} — ${track.artist}`}
                        onClick={() => actions.jumpTo(state.playback.index + index() + 1)}
                      >
                        <span class={styles.nextCover} style={{ 'background-image': `url("${image()}")` }} />
                        <span class={styles.nextMeta}>
                          <strong>{track.title}</strong>
                          <span>{track.artist}</span>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>
        </Show>
      </div>
    </Portal>
  );
}
