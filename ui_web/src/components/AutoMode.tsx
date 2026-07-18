import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { AutoActivity, AutoProfile } from '../lib/autopilot';
import styles from './AutoMode.module.css';

const IDLE_MS = 12_000;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
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
  let touchStartY: number | null = null;
  let restoreFocus: HTMLElement | null = null;
  let wasActive = false;

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

  createEffect(() => {
    current()?.id;
    if (active()) armIdle();
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
        tabIndex={-1}
        onPointerMove={armIdle}
        onPointerDown={(event) => {
          touchStartY = event.clientY;
          armIdle();
        }}
        onPointerUp={(event) => {
          if (touchStartY != null && event.clientY - touchStartY > 90) actions.exitAutoMode();
          touchStartY = null;
        }}
        onKeyDown={onKeyDown}
      >
        <div class={styles.backdrop} style={backdropStyle()} aria-hidden="true" />
        <div class={styles.wash} aria-hidden="true" />
        <div class={styles.grain} aria-hidden="true" />
        <div class={styles.ambientProgress} aria-hidden="true">
          <span style={{ width: `${progress()}%` }} />
        </div>

        <header class={styles.topbar}>
          <div class={styles.brandBlock}>
            <span class={styles.mark} aria-hidden="true"><i /><i /><i /></span>
            <span class={styles.autoLabel}>{t('autoMode.label')}</span>
          </div>
          <button
            class={styles.profile}
            type="button"
            aria-label={t('autoMode.changeProfile', { profile: t(`autoMode.profile.${state.autoMode.profile}`) })}
            onClick={cycleProfile}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" />
            </svg>
            {t(`autoMode.profile.${state.autoMode.profile}`)}
          </button>
          <button class={styles.exit} type="button" aria-label={t('autoMode.exit')} onClick={() => actions.exitAutoMode()}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <Show when={current()}>
          <Show when={upcoming().length > 0}>
            <section class={styles.upStrip} aria-label={t('autoMode.upNext')}>
              <span class={styles.upHead}>{t('autoMode.upNext')}</span>
              <div
                class={styles.filmstrip}
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
                      <button class={styles.nextCard} type="button" onClick={() => actions.jumpTo(state.playback.index + index() + 1)}>
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

          <main class={styles.stage}>
            <section class={styles.hero} aria-live="polite">
              <div class={styles.coverWrap}>
                <div class={styles.coverGlow} style={backdropStyle()} aria-hidden="true" />
                <div class={styles.cover} style={backdropStyle()} role="img" aria-label={current()!.title} />
              </div>
              <div class={styles.meta}>
                <h1>{current()!.title}</h1>
                <p class={styles.artist}>{current()!.artist}</p>
                <Show when={state.autoMode.activity && agentVisible()}>
                  <div
                    class={styles.agent}
                    data-status={state.autoMode.activity!.status}
                    role="status"
                    aria-live="polite"
                  >
                    <span class={styles.agentPulse} aria-hidden="true" />
                    <span>{activityText(state.autoMode.activity!)}</span>
                  </div>
                </Show>
              </div>
            </section>
          </main>

          <footer class={styles.dock}>
            <div class={styles.seek}>
              <span class={styles.time}>{fmt(state.playback.currentTime)}</span>
              <div class={styles.progress}>
                <div class={styles.progressFill} style={{ width: `${progress()}%` }} />
              </div>
              <span class={styles.time}>{fmt(state.playback.duration)}</span>
            </div>
            <div class={styles.transport}>
              <span class={styles.transportSide} aria-hidden="true" />
              <div class={styles.cluster}>
                <button type="button" aria-label={t('common.prev')} onClick={() => actions.prev()}>
                  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
                </button>
                <button class={styles.play} type="button" aria-label={state.playback.isPlaying ? t('common.pause') : t('common.play')} onClick={() => actions.togglePlay()}>
                  <Show when={state.playback.isPlaying} fallback={<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>}>
                    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                  </Show>
                </button>
                <button type="button" aria-label={t('common.next')} onClick={() => void actions.autoSkip()}>
                  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>
                </button>
              </div>
              <div class={styles.transportSide}>
                <Show
                  when={current()!.source !== 'preview'}
                  fallback={
                    <button class={styles.secondaryAction} type="button" aria-label={t('nowPlaying.saveToLibrary')} onClick={() => void actions.downloadTrack(current()!)}>
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14" /></svg>
                    </button>
                  }
                >
                  <button
                    classList={{ [styles.secondaryAction]: true, [styles.liked]: state.favorites.includes(current()!.id) }}
                    type="button"
                    aria-label={state.favorites.includes(current()!.id) ? t('nowPlaying.removeFav') : t('nowPlaying.addFav')}
                    onClick={() => actions.toggleFavourite(current()!.id)}
                  >
                    <svg viewBox="0 0 24 24" width="22" height="22" fill={state.favorites.includes(current()!.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" /></svg>
                  </button>
                </Show>
              </div>
            </div>
          </footer>
        </Show>
      </div>
    </Portal>
  );
}
