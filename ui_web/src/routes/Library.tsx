import Button from '../components/Button';
import { afterPaint } from '../lib/afterPaint';
import albumGrid from '../components/AlbumGrid.module.css';
import artistGrid from '../components/ArtistGrid.module.css';
import { SkeletonCards, SkeletonRows } from '../components/Skeleton';
import { openAlbumBrowseMenu } from '../components/albumBrowseMenu';
import { createEffect, createMemo, createResource, createSignal, Match, on, onMount, Show, Switch } from 'solid-js';
import { A, useSearchParams } from '@solidjs/router';
import { state, actions, downloadCounts, favouriteRows, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { createSearchReveal } from '../components/SearchReveal';
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
  sortTracks,
  filterTracks,
  catalogArtists,
  albumSort,
  albumFilter,
  setAlbumFilter,
} from '../lib/libraryView';
import {
  albumBrowseQuery,
  collateAlbums,
  NO_ALBUM_FILTER,
  type AlbumSort,
} from '../lib/albumBrowse';
import { normalizeLibraryQuery, searchLibrary } from '../lib/librarySearch';
import styles from './Library.module.css';
import { EmptyState } from '../components/EmptyState';
import { DownloadIcon, SortIcon } from '../components/icons';
import type { AppBarAction } from '../lib/appBar';
import { PageCommands } from '../components/PageCommands';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { libraryContext } from '../lib/playbackContext';

export type LibraryCollectionView = 'songs' | 'albums' | 'artists';

/** Collection route: songs (sortable, virtualized), albums, or artists browser. */
export default function Library(props: { view: LibraryCollectionView }) {
  const view = () => props.view;
  const [searchParams, setSearchParams] = useSearchParams();
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
  const gridReady = afterPaint(view);
  const [albumError, setAlbumError] = createSignal(false);
  const [albums, { refetch: retryAlbums }] = createResource(
    () =>
      view() === 'albums'
        ? { ...albumBrowseQuery(albumSort(), albumFilter()), revision: state.catalog.revision }
        : // Not on screen, not fetched. Switching to the tab later asks once,
          // against a catalog revision that has already settled.
          null,
    async (query) => {
      setAlbumError(false);
      try { return await api.getLibraryAlbums(query); }
      catch { setAlbumError(true); return [] as CatalogAlbum[]; }
    },
  );
  const albumRows = createMemo(() => collateAlbums(albums() ?? [], albumSort()));
  const [query, setQuerySignal] = createSignal(
    typeof searchParams.q === 'string' ? searchParams.q : '',
  );
  createEffect(on(() => searchParams.q, (param) => {
    setQuerySignal(typeof param === 'string' ? param : '');
  }, { defer: true }));
  const setQuery = (next: string) => {
    setQuerySignal(next);
    setSearchParams({ q: next || undefined }, { replace: true });
  };
  const searchResults = createMemo(() => searchLibrary(sorted(), artists(), query()));
  const searching = createMemo(() => !!normalizeLibraryQuery(query()));
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

  const search = createSearchReveal(() => ({
    value: query(),
    placeholder: t('library.searchLibrary'),
    onInput: setQuery,
  }), () => t('library.searchAction'));

  onMount(() => {
    if (searchParams.search === '1') {
      setSearchParams({ search: undefined }, { replace: true });
      search.open();
    }
  });

  const sortLabel = (sort: AlbumSort) => t(`library.albumSort.${sort}`);

  const activeFilterLabel = () => {
    const active = albumFilter();
    if (active.kind === 'genre') return active.value;
    if (active.kind === 'year') return String(active.value);
    return '';
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

  const sortCommands = (): AppBarAction[] => {
    const tab = view();
    if (searching() || tab === 'artists') return [];
    const albums = tab === 'albums';
    return [{
      label: t(albums ? 'library.albumSortTitle' : 'library.sortTitle'),
      desktopLabel: albums ? sortLabel(albumSort())
        : librarySort() === 'az' ? t('library.sortAZ') : librarySort() === 'fav' ? t('library.sortFavFirst') : t('library.sortRecent'),
      icon: () => <SortIcon />,
      opensDialog: true,
      onSelect: () => albums ? void openAlbumBrowseMenu() : sortLibrary(),
    }];
  };

  return (
    <div class="view">
      <ViewHeader
        title={t(`library.${view()}` as 'library.songs')}
        search={search}
        rendersOwnCommands
        barActions={sortCommands()}
        onTitleTap={() => reselectPrimaryTab(`/${view()}`)}
        meta={state.loading && songs().length === 0 ? t('common.loading') : trackCount(songs().length)}
        actions={
          <>
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
              <DownloadIcon />
              <Show when={active() > 0}>
                <span class={styles.badge}>{active()}</span>
              </Show>
            </A>
            <PageCommands desktop actions={sortCommands()} />
          </>
        }
      />

      <Show when={!searching() && view() === 'songs' && libraryFilter() === 'downloaded'}>
        <div class={styles.filterChips}>
          <button class={styles.chip} type="button" onClick={() => setLibraryFilter('all')} data-pressable>
            {t('library.filterDownloaded')} <span aria-hidden="true">×</span>
          </button>
        </div>
      </Show>

      {/* The narrowing stays visible and stays undoable: a grid that silently
          holds a filter from a previous session reads as a shrunken library. */}
      <Show when={!searching() && view() === 'albums' && albumFilter().kind !== 'none'}>
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
          <Match when={view() === 'albums'}>
            <Show when={gridReady() && (!albums.loading || albumRows().length > 0)} fallback={<div class="page-loading" tabIndex={0}><SkeletonCards count={12} lines={3} class={albumGrid.grid} /></div>}>
            <Show when={!albumError()} fallback={<EmptyState tone="danger">{t('common.loadFailed')} <Button variant="secondary" onClick={() => void retryAlbums()}>{t('common.retry')}</Button></EmptyState>}>
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
                <Show when={albums.loading}><p role="status">{t('common.loading')}</p></Show>
                <div aria-busy={albums.loading}><AlbumGrid albums={albumRows()} /></div>
              </div>
            </Show>
            </Show></Show>
          </Match>
          <Match when={view() === 'artists'}>
            <Show when={gridReady() && !((state.loading || state.catalog.loading) && artists().length === 0)} fallback={<div class="page-loading" tabIndex={0}><SkeletonCards count={12} shape="round" lines={2} class={artistGrid.grid} /></div>}>
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
            </Show>
          </Match>
          <Match when={true}>
            <TrackList
              tracks={sorted()}
              context={libraryContext(t('library.title'))}
              loading={state.loading}
              empty={emptyState(t('library.emptyLibrary'))}
            />
          </Match>
        </Switch>
      }>
        <Show when={!unreachable()} fallback={emptyState(t('library.emptyLibrary'))}>
          <Show when={!state.loading || songs().length > 0} fallback={<div class={styles.searchLoading}><SkeletonRows count={10} /></div>}>
            <LibrarySearchResults results={searchResults()} query={query()} />
          </Show>
        </Show>
      </Show>
    </div>
  );
}
