import { createMemo, createResource, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { state, actions, downloadCounts, favouriteRows, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import ArtistGrid from '../components/ArtistGrid';
import AlbumGrid from '../components/AlbumGrid';
import LibrarySearchResults from '../components/LibrarySearchResults';
import { openActionMenu } from '../components/ActionMenu';
import { api } from '../lib/api';
import type { CatalogAlbum } from '../types/music';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import {
  librarySort,
  setLibrarySort,
  libraryFilter,
  setLibraryFilter,
  libraryTab,
  setLibraryTab,
  sortTracks,
  filterTracks,
  catalogArtists,
  albumSort,
  setAlbumSort,
  albumFilter,
  setAlbumFilter,
} from '../lib/libraryView';
import {
  albumBrowseQuery,
  collateAlbums,
  NO_ALBUM_FILTER,
  ALBUM_SORTS,
  type AlbumSort,
} from '../lib/albumBrowse';
import { searchLibrary } from '../lib/librarySearch';
import { createTopSwipeReveal } from '../lib/topSwipeReveal';
import styles from './Library.module.css';
import { EmptyState } from '../components/EmptyState';
import { registerPrimaryScroll } from '../lib/scrollHistory';

/** Library view: songs (sortable, virtualized) or artists browser. */
export default function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  let viewRef: HTMLDivElement | undefined;
  const active = createMemo(() => downloadCounts().active);
  // Keyed off the resolved rows rather than library ids, so "favourites first"
  // also lifts the marked songs that have no file — they are in this list too.
  const favSet = createMemo(() => new Set(favouriteRows().map((row) => row.track.id)));
  const songs = createMemo(() => filterTracks(musicLibrary(), libraryFilter()));
  const sorted = createMemo(() => sortTracks(songs(), librarySort(), favSet()));
  const artists = createMemo(() => catalogArtists(state.catalog.artists));

  // The grid re-fetches whenever the ordering, the filter or the catalog itself
  // changes. Ordering and filtering are the engine's job — it is the only party
  // that knows what "most played" or "1994" means across the whole library, and
  // paging a filtered list in the browser would mean filtering it there first.
  const [albums] = createResource(
    () =>
      libraryTab() === 'albums'
        ? { ...albumBrowseQuery(albumSort(), albumFilter()), revision: state.catalog.revision }
        : // Not on screen, not fetched. Switching to the tab later asks once,
          // against a catalog revision that has already settled.
          null,
    (query) => api.getLibraryAlbums(query).catch(() => [] as CatalogAlbum[]),
  );
  const albumRows = createMemo(() => collateAlbums(albums() ?? [], albumSort()));
  const [query, setQuerySignal] = createSignal(
    typeof searchParams.q === 'string' ? searchParams.q : '',
  );
  const setQuery = (next: string) => {
    setQuerySignal(next);
    setSearchParams({ q: next || undefined }, { replace: true });
  };
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
        {t('library.unreachableEmpty')}{' '}
        <button class={styles.retry} type="button" onClick={() => void actions.syncLibrary()}>
          {t('library.retry')}
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
    setSearchProgress(mq.matches ? (searching() ? 1 : 0) : 1);
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
        placeholder={t('library.searchLibrary')}
        aria-label={t('library.searchLibrary')}
      />
      <Show when={query()}>
        <button
          class={styles.clearSearch}
          type="button"
          aria-label={t('library.clearSearch')}
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

  const sortLabel = (sort: AlbumSort) => t(`library.albumSort.${sort}`);

  const activeFilterLabel = () => {
    const active = albumFilter();
    if (active.kind === 'genre') return active.value;
    if (active.kind === 'year') return String(active.value);
    return '';
  };

  /** The album grid's ordering. The choices are the engine's own, so this menu
   * and a Subsonic client's sort menu offer the same list. */
  const sortAlbums = () =>
    openActionMenu({
      title: t('library.albumSortTitle'),
      actions: ALBUM_SORTS.map((sort) => ({
        label: `${albumSort() === sort ? '✓  ' : ''}${sortLabel(sort)}`,
        onSelect: () => setAlbumSort(sort),
      })),
    });

  /** Narrowing the grid: by genre, or by year. One axis at a time — a shelf,
   * not a query builder. Each entry opens the list of values it has, so the
   * choice is always over what the library actually contains. */
  const filterAlbums = () => {
    const active = albumFilter();
    const tick = (on: boolean) => (on ? '✓  ' : '');
    openActionMenu({
      title: t('library.albumFilterTitle'),
      actions: [
        {
          label: `${tick(active.kind === 'none')}${t('library.albumFilterAll')}`,
          onSelect: () => setAlbumFilter(NO_ALBUM_FILTER),
        },
        {
          label: t('library.albumFilterByGenre'),
          disabled: state.catalog.genres.length === 0,
          onSelect: () =>
            openActionMenu({
              title: t('library.albumFilterByGenre'),
              actions: state.catalog.genres.map((genre) => ({
                label: `${tick(active.kind === 'genre' && active.value === genre.name)}${genre.name}`,
                onSelect: () => setAlbumFilter({ kind: 'genre', value: genre.name }),
              })),
            }),
        },
        {
          label: t('library.albumFilterByYear'),
          disabled: state.catalog.years.length === 0,
          onSelect: () =>
            openActionMenu({
              title: t('library.albumFilterByYear'),
              actions: state.catalog.years.map((year) => ({
                label: `${tick(active.kind === 'year' && active.value === year.year)}${year.year}`,
                onSelect: () => setAlbumFilter({ kind: 'year', value: year.year }),
              })),
            }),
        },
      ],
    });
  };

  const sortLibrary = () =>
    openActionMenu({
      sections: [
        {
          label: t('library.sortTitle'),
          actions: [
            ['recent', t('library.sortRecent')],
            ['az', t('library.sortAZ')],
            ['fav', t('library.sortFavFirst')],
          ].map(([value, label]) => ({
            label: `${librarySort() === value ? '✓  ' : ''}${label}`,
            onSelect: () => setLibrarySort(value),
          })),
        },
        {
          label: t('library.filterTitle'),
          actions: [
            {
              label: `${libraryFilter() === 'downloaded' ? '✓  ' : ''}${t('library.filterDownloaded')}`,
              onSelect: () => setLibraryFilter(libraryFilter() === 'downloaded' ? 'all' : 'downloaded'),
            },
          ],
        },
      ],
    });

  return (
    <div ref={viewRef} class="view">
      <ViewHeader
        title={t('library.title')}
        meta={state.loading && songs().length === 0 ? t('common.loading') : trackCount(songs().length)}
        actions={
          <>
            <Show when={!isMobile()}>{searchField(true)}</Show>
            <A class={styles.headerAction} href="/favourites" aria-label={t('library.favourites')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z" />
              </svg>
            </A>
            <A class={styles.headerAction} href="/podcasts" aria-label={t('nav.podcasts')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="11" r="1" />
                <path d="M17.7 17.7A8 8 0 1012 20v-5M15.5 14.5a5 5 0 10-7 0" />
              </svg>
            </A>
            <A class={styles.headerAction} href="/downloads" aria-label={t('library.downloads')} data-pressable>
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
              {t('library.songs')}
            </button>
            <button
              class={styles.tab}
              classList={{ [styles.tabActive]: libraryTab() === 'albums' }}
              type="button"
              onClick={() => setLibraryTab('albums')}
            >
              {t('library.albums')}
            </button>
            <button
              class={styles.tab}
              classList={{ [styles.tabActive]: libraryTab() === 'artists' }}
              type="button"
              onClick={() => setLibraryTab('artists')}
            >
              {t('library.artists')}
            </button>
          </div>
          <Show when={libraryTab() === 'songs'}>
            <button class={styles.sortButton} type="button" onClick={sortLibrary} aria-label={t('library.sortTitle')} data-pressable>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18M6 12h12M10 18h4" />
              </svg>
              <span>{librarySort() === 'az' ? t('library.sortAZ') : librarySort() === 'fav' ? t('library.sortFavFirst') : t('library.sortRecent')}</span>
            </button>
          </Show>
          <Show when={libraryTab() === 'albums'}>
            <div class={styles.albumControls}>
              <button
                class={styles.sortButton}
                type="button"
                onClick={sortAlbums}
                aria-label={t('library.albumSortTitle')}
                data-pressable
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18M6 12h12M10 18h4" />
                </svg>
                <span>{sortLabel(albumSort())}</span>
              </button>
              <button
                class={styles.sortButton}
                type="button"
                onClick={filterAlbums}
                aria-label={t('library.albumFilterTitle')}
                data-pressable
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5h16l-6 7v6l-4 2v-8Z" />
                </svg>
              </button>
            </div>
          </Show>
        </div>
      </Show>

      {/* The narrowing stays visible and stays undoable: a grid that silently
          holds a filter from a previous session reads as a shrunken library. */}
      <Show when={!searching() && libraryTab() === 'albums' && albumFilter().kind !== 'none'}>
        <div class={styles.filterChips}>
          <button
            class={styles.chip}
            type="button"
            onClick={() => setAlbumFilter(NO_ALBUM_FILTER)}
            data-pressable
          >
            <span>{activeFilterLabel()}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </div>
      </Show>

      {/* Stale but not empty: the list below is real, just possibly behind. */}
      <Show when={state.libraryError && songs().length > 0}>
        <p class={styles.stale}>{t('library.unreachable')}</p>
      </Show>

      <Show when={searching()} fallback={
        <Switch>
          <Match when={libraryTab() === 'albums'}>
            <Show
              when={albumRows().length > 0}
              fallback={emptyState(
                albumFilter().kind === 'none' ? t('library.emptyAlbums') : t('library.emptyAlbumFilter'),
              )}
            >
              <div
                ref={(element) => registerPrimaryScroll(element)}
                class={styles.artistsScroll}
                data-library-scroll
                data-primary-scroll
              >
                <AlbumGrid albums={albumRows()} />
              </div>
            </Show>
          </Match>
          <Match when={libraryTab() === 'artists'}>
            <Show when={artists().length > 0} fallback={emptyState(t('library.emptyArtists'))}>
              <div
                ref={(element) => registerPrimaryScroll(element)}
                class={styles.artistsScroll}
                data-library-scroll
                data-primary-scroll
              >
                <ArtistGrid artists={artists()} />
              </div>
            </Show>
          </Match>
          <Match when={true}>
            <TrackList
              tracks={sorted()}
              context={{ id: 'library', kind: 'library', label: t('library.title') }}
              loading={state.loading}
              empty={emptyState(t('library.emptyLibrary'))}
              linkArtist={!isMobile()}
            />
          </Match>
        </Switch>
      }>
        <LibrarySearchResults results={searchResults()} />
      </Show>
    </div>
  );
}
