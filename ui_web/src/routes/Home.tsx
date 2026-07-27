import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions, downloadCounts, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import ArtistGrid from '../components/ArtistGrid';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import { librarySort, setLibrarySort, libraryTab, setLibraryTab, sortTracks, buildArtists } from '../lib/libraryView';
import { createTopSwipeReveal } from '../lib/topSwipeReveal';
import styles from './Home.module.css';
import { EmptyState } from '../components/EmptyState';

/** Library view: songs (sortable, virtualized) or artists browser. */
export default function Home() {
  let viewRef: HTMLDivElement | undefined;
  const active = createMemo(() => downloadCounts().active);
  const favSet = createMemo(() => new Set(state.favorites));
  const songs = createMemo(() => musicLibrary());
  const sorted = createMemo(() => sortTracks(songs(), librarySort(), favSet()));
  const artists = createMemo(() => buildArtists(songs()));
  /** The library never loaded, as opposed to being genuinely empty. */
  const unreachable = createMemo(() => state.libraryError && songs().length === 0);

  /** Empty-state copy that tells the truth about *why* the list is empty, and
   * offers the only useful next step when the engine is the reason. */
  const emptyState = (emptyMessage: string) => (
    <Show when={unreachable()} fallback={<EmptyState>{emptyMessage}</EmptyState>}>
      <EmptyState tone="danger">
        {t('home.unreachableEmpty')}{' '}
        <button class={styles.retry} type="button" onClick={() => void actions.syncLibrary()}>
          {t('home.retry')}
        </button>
      </EmptyState>
    </Show>
  );

  // Desktop breakpoint is 1024px (matches app.module.css / tokens.css). On
  // mobile the song row's subtitle is the same gesture as the row itself, so
  // we render the artist as plain text and let the row click play the track.
  const [isMobile, setIsMobile] = createSignal(true);
  const [toolbarProgress, setToolbarProgress] = createSignal(0);
  const [toolbarDragging, setToolbarDragging] = createSignal(false);
  const swipeReveal = createTopSwipeReveal();

  onMount(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) {
        setToolbarProgress(1);
        setToolbarDragging(false);
      } else {
        setToolbarProgress(0);
      }
    };
    mq.addEventListener('change', onChange);

    const scrollSurface = (target: EventTarget | null) =>
      target instanceof HTMLElement ? target.closest<HTMLElement>('[data-library-scroll]') : null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || toolbarProgress() > 0) return;
      const surface = scrollSurface(event.target);
      const touch = event.touches[0];
      swipeReveal.begin(touch.clientX, touch.clientY, event.timeStamp, !!surface && surface.scrollTop <= 1, isMobile());
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || (toolbarProgress() >= 1 && !toolbarDragging())) return;
      const touch = event.touches[0];
      const frame = swipeReveal.move(touch.clientX, touch.clientY, event.timeStamp);
      if (!frame.captured) return;
      event.preventDefault();
      setToolbarDragging(true);
      setToolbarProgress(frame.progress);
    };
    const finishTouch = (event: TouchEvent) => {
      if (toolbarProgress() >= 1 && !toolbarDragging()) return;
      const frame = swipeReveal.end(event.timeStamp);
      if (frame.captured) event.preventDefault();
      setToolbarDragging(false);
      setToolbarProgress(frame.progress);
    };
    const cancelTouch = () => {
      const frame = swipeReveal.cancel();
      setToolbarDragging(false);
      if (frame.captured) setToolbarProgress(0);
    };
    const onScroll = (event: Event) => {
      const surface = scrollSurface(event.target);
      if (isMobile() && toolbarProgress() === 1 && surface && surface.scrollTop > 24) {
        setToolbarProgress(0);
      }
    };

    const view = viewRef;
    view?.addEventListener('touchstart', onTouchStart, { passive: true });
    view?.addEventListener('touchmove', onTouchMove, { passive: false });
    view?.addEventListener('touchend', finishTouch, { passive: false });
    view?.addEventListener('touchcancel', cancelTouch, { passive: true });
    view?.addEventListener('scroll', onScroll, true);

    onCleanup(() => {
      mq.removeEventListener('change', onChange);
      view?.removeEventListener('touchstart', onTouchStart);
      view?.removeEventListener('touchmove', onTouchMove);
      view?.removeEventListener('touchend', finishTouch);
      view?.removeEventListener('touchcancel', cancelTouch);
      view?.removeEventListener('scroll', onScroll, true);
    });
  });

  const toolbarStyle = () =>
    isMobile()
      ? `height:${toolbarProgress() * 44}px;--toolbar-reveal:${toolbarProgress()};--toolbar-offset:${(1 - toolbarProgress()) * -8}px`
      : undefined;
  const toolbarHidden = () => isMobile() && toolbarProgress() === 0;

  return (
    <div ref={viewRef} class="view">
      <ViewHeader
        title={t('home.title')}
        meta={state.loading && songs().length === 0 ? t('common.loading') : trackCount(songs().length)}
      />
      <nav class={styles.chips}>
        <A href="/favourites" class={styles.chip}>
          {t('home.favourites')}
        </A>
        <A href="/playlists" class={styles.chip}>
          {t('home.playlists')}
        </A>
        <A href="/podcasts" class={styles.chip}>
          {t('home.podcasts')}
        </A>
        <A href="/downloads" class={styles.chip}>
          {t('home.downloads')}
          <Show when={active() > 0}>
            <span class={styles.badge}>{active()}</span>
          </Show>
        </A>
      </nav>

      <div
        class={styles.toolbarReveal}
        classList={{ [styles.toolbarDragging]: toolbarDragging() }}
        style={toolbarStyle()}
        aria-hidden={toolbarHidden() ? 'true' : undefined}
        inert={toolbarHidden()}
      >
        <div class={styles.toolbar}>
          <div class={styles.tabs}>
            <button
              class={styles.tab}
              classList={{ [styles.tabActive]: libraryTab() === 'songs' }}
              type="button"
              onClick={() => setLibraryTab('songs')}
            >
              {t('home.songs')}
            </button>
            <button
              class={styles.tab}
              classList={{ [styles.tabActive]: libraryTab() === 'artists' }}
              type="button"
              onClick={() => setLibraryTab('artists')}
            >
              {t('home.artists')}
            </button>
          </div>
          <Show when={libraryTab() === 'songs'}>
            <select class={styles.select} value={librarySort()} onChange={(e) => setLibrarySort(e.currentTarget.value)}>
              <option value="recent">{t('home.sortRecent')}</option>
              <option value="az">{t('home.sortAZ')}</option>
              <option value="fav">{t('home.sortFavFirst')}</option>
            </select>
          </Show>
        </div>
      </div>

      {/* Stale but not empty: the list below is real, just possibly behind. */}
      <Show when={state.libraryError && songs().length > 0}>
        <p class={styles.stale}>{t('home.unreachable')}</p>
      </Show>

      <Show
        when={libraryTab() === 'songs'}
        fallback={
          <Show when={artists().length > 0} fallback={emptyState(t('home.emptyArtists'))}>
            <div class={styles.artistsScroll} data-library-scroll>
              <ArtistGrid artists={artists()} />
            </div>
          </Show>
        }
      >
        <TrackList
          tracks={sorted()}
          loading={state.loading}
          empty={emptyState(t('home.emptyLibrary'))}
          linkArtist={!isMobile()}
        />
      </Show>
    </div>
  );
}
