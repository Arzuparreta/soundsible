import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { Control } from '../design/Control';
import { TV_REMOTE_COMMANDS } from '../lib/deviceIdentity';
import { t } from '../lib/i18n';
import { logout, user } from '../lib/session';
import { actions, disposeStore, initStore, state } from '../stores';
import { TvMiniBar } from './components/TvMiniBar';
import { TvRail } from './components/TvRail';
import { isSuppressedTvKeyRepeat, isTextInputElement, normalizeTvKey, type TvAction } from './nav/input';
import { createTvRouter } from './nav/router';
import { TvFocusProvider, useTvFocus } from './nav/spatial';
import { TvAccount } from './screens/TvAccount';
import { TvAlbumDetail } from './screens/TvAlbumDetail';
import { TvDimOverlay } from './screens/TvDimOverlay';
import { TvHome } from './screens/TvHome';
import { TvLibrary } from './screens/TvLibrary';
import { TvNowPlaying } from './screens/TvNowPlaying';
import { TvPlaylistDetail } from './screens/TvPlaylistDetail';
import { TvQueueOverlay } from './screens/TvQueueOverlay';
import { TvSearch } from './screens/TvSearch';
import { dimActive, resetTvState, setDimActive, tvNotice } from './state';
import styles from './styles/tv.module.css';

interface TvAppProps {
  onReady?: () => void;
}

function TvSignOutModal(props: { open: () => boolean; onClose: () => void }) {
  const focus = useTvFocus();
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (!props.open()) return;
    focus.pushModal('tv-signout-confirm', 'tv-signout-cancel');
    const unregisterBack = focus.registerBackHandler(() => {
      if (!props.open()) return false;
      props.onClose();
      return true;
    });
    onCleanup(() => {
      unregisterBack();
      focus.popModal('tv-signout-confirm');
    });
  });

  const displayName = () => user()?.display_name || user()?.username || '';

  return (
    <Show when={props.open()}>
      <div class={styles.tvModalBackdrop} role="presentation">
        <section
          class={styles.tvModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tv-signout-modal-title"
          data-tv-modal="tv-signout-confirm"
        >
          <h2 id="tv-signout-modal-title" class={styles.tvPageTitle}>
            {t('tv.account.signOutConfirmTitle', { name: displayName() })}
          </h2>
          <p class={styles.tvSubtitle}>{t('tv.account.signOutConfirmBody')}</p>
          <div
            class={styles.tvRowGroup}
            data-tv-group-container="tv-signout-actions"
            data-tv-group-kind="row"
            data-tv-group-order="10"
            data-tv-rail-edge="none"
          >
            <Control
              data-tv-id="tv-signout-cancel"
              data-tv-group="tv-signout-actions"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'tv-signout-cancel' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={props.onClose}
            >
              {t('tv.cancel')}
            </Control>
            <Control
              data-tv-id="tv-signout-confirm-btn"
              data-tv-group="tv-signout-actions"
              data-tv-index="1"
              data-tv-focused={focus.activeId() === 'tv-signout-confirm-btn' ? 'true' : undefined}
              class={styles.tvDangerBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              disabled={busy()}
              onClick={() => {
                setBusy(true);
                void logout();
              }}
            >
              {t('tv.signOut')}
            </Control>
          </div>
        </section>
      </div>
    </Show>
  );
}

function TvShellInner(props: TvAppProps) {
  const focus = useTvFocus();
  const router = createTvRouter();
  const [signOutOpen, setSignOutOpen] = createSignal(false);
  const interceptors = new Set<(action: TvAction) => boolean>();

  function registerActionInterceptor(handler: (action: TvAction) => boolean): () => void {
    interceptors.add(handler);
    return () => {
      interceptors.delete(handler);
    };
  }

  function pushWithSnapshot(hash: string): void {
    const snap = focus.snapshotScrollState();
    router.push(hash, {
      focusedId: focus.activeId(),
      scrollTop: snap.mainTop,
      shelfScrolls: snap.shelves,
    });
    queueMicrotask(() => {
      const scroller = document.querySelector<HTMLElement>('[data-tv-scroll-y="main"]');
      if (scroller) scroller.scrollTop = 0;
      focus.focusFirstInContent();
    });
  }

  function handleRoutePop(): boolean {
    if (!router.canPopOrReturnHome()) return false;
    const restored = router.pop();
    if (!restored) return false;
    queueMicrotask(() => {
      focus.restoreScrollState(restored.scrollTop, restored.shelfScrolls);
      if (restored.focusedId && focus.restoreFocus(restored.focusedId)) return;
      focus.reconcileFocus();
    });
    return true;
  }

  function handleRailSelect(hash: string): void {
    if (router.route().hash === hash) {
      focus.exitRail();
      return;
    }
    router.replaceRoot(hash);
    queueMicrotask(() => {
      const scroller = document.querySelector<HTMLElement>('[data-tv-scroll-y="main"]');
      if (scroller) scroller.scrollTop = 0;
      focus.focusFirstInContent();
    });
  }

  onMount(() => {
    initStore({
      desktopShortcuts: false,
      remoteCommands: TV_REMOTE_COMMANDS,
    });
    props.onReady?.();

    const onHashChange = () => {
      router.syncFromLocation(window.location.hash);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const action = normalizeTvKey(event, document.activeElement);
      if (!action) {
        if (isSuppressedTvKeyRepeat(event, document.activeElement)) {
          event.preventDefault();
        }
        return;
      }

      // 1. Waking from dimmed screen consumes first key press without navigating.
      if (dimActive()) {
        if (
          action === 'up' ||
          action === 'down' ||
          action === 'left' ||
          action === 'right' ||
          action === 'select' ||
          action === 'back'
        ) {
          event.preventDefault();
          setDimActive(false);
          return;
        }
      }

      // 2. Global remote media transport keys work from any route or focus target.
      if (action === 'media_toggle') {
        event.preventDefault();
        if (state.playback.currentTrack) actions.togglePlay();
        return;
      }
      if (action === 'media_play') {
        event.preventDefault();
        actions.resumePlayback('media_session');
        return;
      }
      if (action === 'media_pause' || action === 'media_stop') {
        event.preventDefault();
        actions.pausePlayback('media_session');
        return;
      }
      if (action === 'media_next') {
        event.preventDefault();
        actions.next();
        return;
      }
      if (action === 'media_prev') {
        event.preventDefault();
        actions.prev();
        return;
      }

      // 3. Control-specific interceptors (seek bar preview/commit/cancel).
      for (const interceptor of Array.from(interceptors).reverse()) {
        if (interceptor(action)) {
          event.preventDefault();
          return;
        }
      }

      // 4. Ordered Back stack: blur input -> seek preview / modal -> exit rail -> pop route -> root exit.
      if (action === 'back') {
        const active = document.activeElement as HTMLElement | null;
        if (isTextInputElement(active)) {
          event.preventDefault();
          active?.blur();
          focus.reconcileFocus();
          return;
        }
        if (focus.handleBackAction()) {
          event.preventDefault();
          return;
        }
        if (focus.inRail() && !router.canPopOrReturnHome()) {
          if (focus.exitRail()) {
            event.preventDefault();
            return;
          }
        }
        if (handleRoutePop()) {
          event.preventDefault();
        }
        return;
      }

      // 5. Spatial D-pad navigation.
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        event.preventDefault();
        focus.move(action);
        return;
      }

      // 6. OK / Select activates the active TV control.
      if (action === 'select') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset?.tvId) {
          event.preventDefault();
          active.click();
        }
      }
    };

    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('keydown', onKeyDown, true);

    onCleanup(() => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('keydown', onKeyDown, true);
      resetTvState();
      disposeStore();
    });
  });

  const activeRoute = router.route;

  return (
    <div class={styles.tvRoot}>
      <div class={styles.tvLayout}>
        <div class={styles.tvRailSlot}>
          <TvRail currentRoute={activeRoute} onSelect={handleRailSelect} />
        </div>
        <main class={styles.tvMain}>
          <div class={styles.tvScroll} data-tv-scroll-y="main">
            <Switch>
              <Match when={activeRoute().name === 'home'}>
                <TvHome
                  onNavigate={pushWithSnapshot}
                  onRequestSignOut={() => setSignOutOpen(true)}
                />
              </Match>
              <Match when={activeRoute().name === 'search'}>
                <TvSearch onNavigate={pushWithSnapshot} />
              </Match>
              <Match when={activeRoute().name === 'library'}>
                <TvLibrary onNavigate={pushWithSnapshot} />
              </Match>
              <Match when={activeRoute().name === 'album'}>
                {(() => {
                  const r = activeRoute();
                  if (r.name !== 'album') return null;
                  return (
                    <TvAlbumDetail
                      albumId={r.albumId}
                      albumName={r.albumName}
                      artist={r.artist}
                      deezerId={r.deezerId}
                      onBack={() => void handleRoutePop()}
                    />
                  );
                })()}
              </Match>
              <Match when={activeRoute().name === 'playlist'}>
                {(() => {
                  const r = activeRoute();
                  if (r.name !== 'playlist') return null;
                  return (
                    <TvPlaylistDetail
                      playlistName={r.playlistName}
                      onBack={() => void handleRoutePop()}
                    />
                  );
                })()}
              </Match>
              <Match when={activeRoute().name === 'now-playing'}>
                <TvNowPlaying
                  onNavigateHome={() => handleRailSelect('#/home')}
                  registerActionInterceptor={registerActionInterceptor}
                />
              </Match>
              <Match when={activeRoute().name === 'account'}>
                <TvAccount onRequestSignOut={() => setSignOutOpen(true)} />
              </Match>
            </Switch>
          </div>
          <Show when={activeRoute().name !== 'now-playing'}>
            <TvMiniBar onOpenNowPlaying={() => pushWithSnapshot('#/now-playing')} />
          </Show>
        </main>
      </div>

      <TvQueueOverlay />
      <TvDimOverlay />
      <TvSignOutModal open={signOutOpen} onClose={() => setSignOutOpen(false)} />

      <Show when={tvNotice()}>
        {(msg) => (
          <div class={styles.tvToast} role="status" aria-live="polite">
            {msg()}
          </div>
        )}
      </Show>
    </div>
  );
}

export default function TvApp(props: TvAppProps) {
  return (
    <TvFocusProvider>
      <TvShellInner onReady={props.onReady} />
    </TvFocusProvider>
  );
}
