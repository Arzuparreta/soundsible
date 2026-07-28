import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions, downloadCounts, favouriteLibraryIds, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import ArtistGrid from '../components/ArtistGrid';
import LibrarySearchResults from '../components/LibrarySearchResults';
import { openActionMenu } from '../components/ActionMenu';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import { librarySort, setLibrarySort, libraryTab, setLibraryTab, sortTracks, buildArtists } from '../lib/libraryView';
import { searchLibrary } from '../lib/librarySearch';
import { createTopSwipeReveal } from '../lib/topSwipeReveal';
import styles from './Home.module.css';
import { EmptyState } from '../components/EmptyState';

/** Library view: songs (sortable, virtualized) or artists browser. */
export default function Home() {
  let viewRef: HTMLDivElement | undefined;
  const active = createMemo(() => downloadCounts().active);
  // Sorting the library by favourites only concerns the tracks in it.
  const favSet = createMemo(() => new Set(favouriteLibraryIds()));
  const songs = createMemo(() => musicLibrary());
  const sorted = createMemo(() => sortTracks(songs(), librarySort(), favSet()));
  const artists = createMemo(() => buildArtists(songs()));
  const [query, setQuery] = createSignal('');
  const [searchFocused, setSearchFocused] = createSignal(false);
  const searchResults = createMemo(() => searchLibrary(sorted(), artists(), query()));
  const searching = createMemo(() => query().trim().length > 0);
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
  const [searchProgress, setSearchProgress] = createSignal(0);
  const [searchDragging, setSearchDragging] = createSignal(false);
  const swipeReveal = createTopSwipeReveal();

  onMount(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) {
        setSearchProgress(1);
        setSearchDragging(false);
      } else {
        setSearchProgress(searching() || searchFocused() ? 1 : 0);
      }
    };
    mq.addEventListener('change', onChange);

    const scrollSurface = (target: EventTarget | null) =>
      target instanceof HTMLElement ? target.closest<HTMLElement>('[data-library-scroll]') : null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || searchProgress() > 0) return;
      const surface = scrollSurface(event.target);
      const touch = event.touches[0];
      swipeReveal.begin(touch.clientX, touch.clientY, event.timeStamp, !!surface && surface.scrollTop <= 1, isMobile());
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || (searchProgress() >= 1 && !searchDragging())) return;
      const touch = event.touches[0];
      const frame = swipeReveal.move(touch.clientX, touch.clientY, event.timeStamp);
      if (!frame.captured) return;
      event.preventDefault();
      setSearchDragging(true);
      setSearchProgress(frame.progress);
    };
    const finishTouch = (event: TouchEvent) => {
      if (searchProgress() >= 1 && !searchDragging()) return;
      const frame = swipeReveal.end(event.timeStamp);
      if (frame.captured) event.preventDefault();
      setSearchDragging(false);
      setSearchProgress(frame.progress);
    };
    const cancelTouch = () => {
      const frame = swipeReveal.cancel();
      setSearchDragging(false);
      if (frame.captured) setSearchProgress(0);
    };
    const onScroll = (event: Event) => {
      const surface = scrollSurface(event.target);
      if (
        isMobile() &&
        searchProgress() === 1 &&
        !searching() &&
        !searchFocused() &&
        surface &&
        surface.scrollTop > 24
      ) {
        setSearchProgress(0);
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

  const searchRevealStyle = () =>
    isMobile()
      ? `height:${searchProgress() * 56}px;--search-reveal:${searchProgress()};--search-offset:${(1 - searchProgress()) * -8}px`
      : undefined;
  const searchHidden = () => isMobile() && searchProgress() === 0;

  /** The library filter. Desktop puts it on the header row, where there is idle
   * space next to the title; mobile keeps it under the header, inside the strip
   * the swipe gesture reveals. */
  const searchField = (inHeader: boolean) => (
    <div class={styles.localSearch} classList={{ [styles.headerSearch]: inHeader }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
      <input
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onFocus={() => {
          setSearchFocused(true);
          setSearchProgress(1);
        }}
        onBlur={() => setSearchFocused(false)}
        placeholder={t('home.searchLibrary')}
        aria-label={t('home.searchLibrary')}
      />
      <Show when={query()}>
        <button
          class={styles.clearSearch}
          type="button"
          aria-label={t('home.clearSearch')}
          onClick={() => setQuery('')}
          data-pressable
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </Show>
    </div>
  );

  const sortLibrary = () =>
    openActionMenu({
      title: t('home.sortTitle'),
      actions: [
        ['recent', t('home.sortRecent')],
        ['az', t('home.sortAZ')],
        ['fav', t('home.sortFavFirst')],
      ].map(([value, label]) => ({
        label: `${librarySort() === value ? '✓  ' : ''}${label}`,
        onSelect: () => setLibrarySort(value),
      })),
    });

  return (
    <div ref={viewRef} class="view">
      <ViewHeader
        title={t('home.title')}
        meta={state.loading && songs().length === 0 ? t('common.loading') : trackCount(songs().length)}
        actions={
          <>
            <Show when={!isMobile()}>{searchField(true)}</Show>
            <A class={styles.headerAction} href="/favourites" aria-label={t('home.favourites')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z" />
              </svg>
            </A>
            <A class={styles.headerAction} href="/downloads" aria-label={t('home.downloads')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />
              </svg>
              <Show when={active() > 0}>
                <span class={styles.badge}>{active()}</span>
              </Show>
            </A>
          </>
        }
      />

      <Show when={isMobile()}>
        <div
          class={styles.searchReveal}
          classList={{ [styles.searchDragging]: searchDragging() }}
          style={searchRevealStyle()}
          aria-hidden={searchHidden() ? 'true' : undefined}
          inert={searchHidden()}
        >
          {searchField(false)}
        </div>
      </Show>

      <Show when={!searching()}>
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
            <button class={styles.sortButton} type="button" onClick={sortLibrary} aria-label={t('home.sortTitle')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18M6 12h12M10 18h4" />
              </svg>
              <span>{librarySort() === 'az' ? t('home.sortAZ') : librarySort() === 'fav' ? t('home.sortFavFirst') : t('home.sortRecent')}</span>
            </button>
          </Show>
        </div>
      </Show>

      {/* Stale but not empty: the list below is real, just possibly behind. */}
      <Show when={state.libraryError && songs().length > 0}>
        <p class={styles.stale}>{t('home.unreachable')}</p>
      </Show>

      <Show when={searching()} fallback={
        <Show
          when={libraryTab() === 'songs'}
          fallback={
            <Show when={artists().length > 0} fallback={emptyState(t('home.emptyArtists'))}>
              <div class={styles.artistsScroll} data-library-scroll data-primary-scroll>
                <ArtistGrid artists={artists()} />
              </div>
            </Show>
          }
        >
          <TrackList
            tracks={sorted()}
            context={{ id: 'library', kind: 'library', label: t('home.title') }}
            loading={state.loading}
            empty={emptyState(t('home.emptyLibrary'))}
            linkArtist={!isMobile()}
          />
        </Show>
      }>
        <LibrarySearchResults results={searchResults()} />
      </Show>
    </div>
  );
}
