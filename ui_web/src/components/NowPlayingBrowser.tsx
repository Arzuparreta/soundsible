import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { api } from '../lib/api';
import {
  actions,
  favouriteLibraryIds,
  favouriteTracks,
  isPlayingItem,
  isPlayingResult,
  isPlayingTrack,
  isQueuedItem,
  isQueuedResult,
  isQueuedTrack,
  musicLibrary,
  ownedTrackForItem,
  ownedTrackForResult,
  state,
} from '../stores';
import { coverUrl } from '../lib/media';
import { coverStyle } from '../lib/cover';
import { parseYouTubeInput } from '../lib/youtube';
import { ensureNodeFeed, nodeFeed, nodeLoading, refreshNodeFeed } from '../lib/nodeDiscover';
import { buildArtists, librarySort, libraryTab, setLibrarySort, setLibraryTab, sortTracks } from '../lib/libraryView';
import { artistKey } from '../lib/artistRoute';
import { searchLibrary, type LibrarySearchResult } from '../lib/librarySearch';
import { catalogPreviewId, itemArtist, itemToTrack, playCatalogItem } from '../lib/catalogItem';
import { writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { catalogItemKeys } from '../lib/playbackIdentity';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { prefetchPreviews } from '../lib/prefetch';
import { isPodcastTrack } from '../lib/track';
import { pickPlaylistCoverId } from '../lib/playlists';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { openActionMenu } from './ActionMenu';
import { VirtualRows } from './VirtualRows';
import { Spinner } from './Spinner';
import { SkeletonRows } from './Skeleton';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { readSearchCache, writeSearchCache } from '../lib/searchCache';
import {
  resolveSections,
  topResultItem,
  CATALOG_CACHE_NS,
  type CachedCatalog,
  type ResolvedSection,
} from '../lib/searchSections';
import type { CatalogItem, CatalogSection, SearchResult, Track } from '../types/music';
import styles from './NowPlayingBrowser.module.css';

export type BrowserView =
  | { kind: 'root' }
  | { kind: 'library' }
  | { kind: 'favourites' }
  | { kind: 'libraryArtist'; name: string }
  | { kind: 'playlists' }
  | { kind: 'playlist'; name: string }
  | { kind: 'catalogArtist'; name: string; deezerId?: string }
  | { kind: 'catalogAlbum'; name: string; artist: string; deezerId?: string };

type SearchReturn = {
  query: string;
  scope: 'global' | 'library';
};

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function playableTrack(item: CatalogItem): Track | null {
  const direct = itemToTrack(item);
  if (direct) return direct;
  const id = catalogPreviewId(item);
  if (!id) return null;
  return {
    id,
    title: item.title,
    artist: itemArtist(item),
    album: item.album,
    duration: item.duration,
    cover: item.cover,
    source: 'preview',
    originKeys: catalogItemKeys(item),
  };
}

function resultTrack(result: SearchResult): Track {
  return {
    id: result.id,
    title: result.title,
    artist: result.channel ?? '',
    duration: result.duration,
    cover: result.thumbnail,
    source: 'preview',
  };
}

async function enqueueCatalogItem(item: CatalogItem): Promise<void> {
  const immediate = itemToTrack(item);
  if (immediate) {
    actions.enqueue(immediate);
    return;
  }
  const artist = itemArtist(item);
  if (!artist) return;
  try {
    const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
    if (!resolved.video_id) throw new Error('unresolved');
    actions.linkCatalogItem(item.id, resolved.video_id);
    actions.enqueue({
      id: resolved.video_id,
      title: item.title,
      artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview',
      originKeys: catalogItemKeys(item),
    });
  } catch {
    toast.error(t('searchPanel.noResolve'));
  }
}

function trackCover(track: Track): string | undefined {
  return track.source === 'preview' ? track.cover : coverUrl(track.id);
}

export function NowPlayingBrowser(props: {
  onClose: () => void;
  dragHandle?: JSX.Element;
  purpose?: 'browse' | 'auto-neutral' | 'auto-route' | 'auto-source';
  routeBeforeQueueId?: string;
  onPlaced?: () => void;
  onSourceAdded?: () => void;
  onCarryTrack?: (track: Track) => void;
}) {
  const routeMode = () => props.purpose === 'auto-route';
  const sourceMode = () => props.purpose === 'auto-source';
  const autoNeutral = () => props.purpose === 'auto-neutral';
  const [stack, setStack] = createSignal<BrowserView[]>([{ kind: 'root' }]);
  const [returnSearches, setReturnSearches] = createSignal<Array<SearchReturn | null>>([null]);
  const currentView = createMemo(() => stack()[stack().length - 1] ?? { kind: 'root' as const });
  const [scope, setScope] = createSignal<'global' | 'library'>('global');
  const [query, setQuery] = createSignal('');
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sections, setSections] = createSignal<CatalogSection[]>([]);
  const [ytResults, setYtResults] = createSignal<SearchResult[]>([]);
  const [direct, setDirect] = createSignal<SearchResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [ytLoading, setYtLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [resolving, setResolving] = createSignal<Set<string>>(new Set());
  let inputEl: HTMLInputElement | undefined;
  let debounce: number | undefined;
  let aborter: AbortController | undefined;
  let requestId = 0;

  ensureNodeFeed();

  const libraryTracks = createMemo(() =>
    sortTracks(musicLibrary(), librarySort(), new Set(favouriteLibraryIds())),
  );
  const favourites = createMemo(() => favouriteTracks().filter((track) => !isPodcastTrack(track)));
  const libraryArtists = createMemo(() => buildArtists(musicLibrary()));
  const localResults = createMemo(() =>
    scope() === 'library' ? searchLibrary(libraryTracks(), libraryArtists(), query()) : [],
  );
  const globalSearching = createMemo(() => scope() === 'global' && query().trim().length >= 2);
  const localSearching = createMemo(() => scope() === 'library' && query().trim().length > 0);
  // The panel used to render entities first and then songs, while the Search
  // route rendered songs first and then entities — two hardcoded orders, both
  // wrong in the other's case. Both now follow the one the server sends.
  const resolved = createMemo(() => resolveSections(items(), sections()));
  const topResult = createMemo(() => topResultItem(resolved()));
  const panelSections = createMemo<ResolvedSection[]>(() => {
    const body = resolved().filter((section) => section.id !== 'top');
    // Asking the DJ for something only makes sense for an artist.
    if (!routeMode()) return body;
    return body
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => item.type !== 'album' && item.type !== 'playlist',
        ),
      }))
      .filter((section) => section.items.length > 0);
  });
  const playlistNames = createMemo(() => Object.keys(state.playlists));
  const byId = createMemo(() => new Map(state.library.map((track) => [track.id, track] as const)));
  const currentMusic = createMemo(() => {
    const current = state.playback.currentTrack;
    return current && !isPodcastTrack(current) ? current : null;
  });
  const surprisePool = createMemo(() => {
    const favourites = musicLibrary().filter((track) => favouriteLibraryIds().has(track.id));
    return favourites.length >= 3 ? favourites : musicLibrary();
  });

  const push = (view: BrowserView, returnToSearch = false) => {
    setStack((views) => [...views, view]);
    setReturnSearches((searches) => [
      ...searches,
      returnToSearch ? { query: query(), scope: scope() } : null,
    ]);
    setScope('global');
    setQuery('');
  };
  const back = () => {
    const restore = returnSearches()[returnSearches().length - 1];
    if (stack().length > 1) {
      setStack((views) => views.slice(0, -1));
      setReturnSearches((searches) => searches.slice(0, -1));
    } else {
      setStack([{ kind: 'root' }]);
      setReturnSearches([null]);
    }
    setScope(restore?.scope ?? 'global');
    setQuery(restore?.query ?? '');
    if (restore?.scope === 'global' && restore.query) runSearch(restore.query);
    else clearSearchState();
  };

  const clearSearchState = () => {
    requestId += 1;
    aborter?.abort();
    setItems([]);
    setSections([]);
    setYtResults([]);
    setDirect(null);
    setLoading(false);
    setYtLoading(false);
    setFailed(false);
  };

  const runSearch = (raw: string) => {
    const q = raw.trim();
    const request = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setFailed(false);
    setItems([]);
    setSections([]);
    setYtResults([]);
    setDirect(null);

    if (scope() !== 'global' || q.length < 2) {
      setLoading(false);
      setYtLoading(false);
      return;
    }
    aborter = new AbortController();
    const signal = aborter.signal;
    const pasted = parseYouTubeInput(q);
    if (pasted) {
      setYtLoading(true);
      api.peekYouTube(pasted.url, signal)
        .then((result) => {
          if (request !== requestId) return;
          setDirect(result ?? {
            id: pasted.videoId,
            title: t('searchPanel.fallbackTitle'),
            channel: t('searchPanel.fallbackChannel'),
          });
        })
        .catch((error) => {
          if (!isAbort(error) && request === requestId) setFailed(true);
        })
        .finally(() => {
          if (request === requestId) setYtLoading(false);
        });
      return;
    }

    // Same namespace the Search route writes to, so opening the panel after a
    // search — or searching the same thing in both — costs nothing. This panel
    // used to re-fetch every single time.
    const cached = readSearchCache<CachedCatalog>(CATALOG_CACHE_NS, q);
    if (cached) {
      setItems(cached.items);
      setSections(cached.sections);
      setLoading(false);
      return;
    }

    setLoading(true);
    api.searchCatalog(q, signal)
      .then((response) => {
        if (request !== requestId) return;
        setItems(response.items ?? []);
        setSections(response.sections ?? []);
        writeSearchCache(CATALOG_CACHE_NS, q, {
          items: response.items ?? [],
          sections: response.sections ?? [],
          interpretedAs: response.interpreted_as ?? '',
        });
        if (!(response.items ?? []).some((item) => item.type === 'track' || item.type === 'library_track')) {
          setYtLoading(true);
          return api.searchYouTube(q, signal).then((results) => {
            if (request === requestId) setYtResults(results);
          });
        }
      })
      .catch((error) => {
        if (isAbort(error) || request !== requestId) return;
        setYtLoading(true);
        return api.searchYouTube(q, signal)
          .then((results) => {
            if (request === requestId) setYtResults(results);
          })
          .catch((fallbackError) => {
            if (!isAbort(fallbackError) && request === requestId) setFailed(true);
          });
      })
      .finally(() => {
        if (request === requestId) {
          setLoading(false);
          setYtLoading(false);
        }
      });
  };

  const onInput = (value: string) => {
    setQuery(value);
    clearTimeout(debounce);
    if (scope() === 'library') return;
    debounce = window.setTimeout(() => runSearch(value), 230);
  };

  const clear = () => {
    clearTimeout(debounce);
    setQuery('');
    clearSearchState();
    inputEl?.focus();
  };

  const activateLibrarySearch = () => {
    clearSearchState();
    setScope('library');
    setQuery('');
    requestAnimationFrame(() => inputEl?.focus());
  };

  const leaveLibrarySearch = () => {
    const value = query();
    clearSearchState();
    setScope('global');
    if (value) runSearch(value);
  };

  const markResolving = (key: string, active: boolean) =>
    setResolving((current) => {
      const next = new Set(current);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });

  const resolveItem = async (item: CatalogItem): Promise<Track | null> => {
    const immediate = playableTrack(item);
    if (immediate) return immediate;
    const artist = itemArtist(item);
    if (!artist) return null;
    const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
    if (!resolved.video_id) return null;
    actions.linkCatalogItem(item.id, resolved.video_id);
    return {
      id: resolved.video_id,
      title: item.title,
      artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview',
      originKeys: catalogItemKeys(item),
    };
  };

  const useItem = async (item: CatalogItem, action: (track: Track) => void) => {
    markResolving(item.id, true);
    try {
      const track = await resolveItem(item);
      if (!track) throw new Error('unresolved');
      action(track);
    } catch {
      toast.error(t('searchPanel.noResolve'));
    } finally {
      markResolving(item.id, false);
    }
  };

  const placeTrack = (track: Track) => {
    void actions.placeAutoTrack(track, props.routeBeforeQueueId);
    props.onPlaced?.();
  };
  const sourceTrack = (track: Track) => {
    actions.useAutoTrackAsSource(track);
    props.onSourceAdded?.();
  };

  createEffect(() => {
    const ids = [
      ...items()
        .filter((item) => item.type === 'track' || item.type === 'library_track')
        .map(catalogPreviewId)
        .filter((id): id is string => !!id),
      ...ytResults().map((result) => result.id),
      ...(direct() ? [direct()!.id] : []),
    ].slice(0, 8);
    if (ids.length) prefetchPreviews(ids);
  });

  onCleanup(() => {
    clearTimeout(debounce);
    aborter?.abort();
  });

  const openTrackActions = (track: Track, event?: MouseEvent) =>
    openTrackMenu(track, {
      onAddToPlaylist: openPlaylistPicker,
      onEditMetadata: openMetadataEditor,
      onPlayOnDevice: openPlayOnDevice,
    }, event);

  const renderTrack = (
    track: Track,
    onPlay: () => void,
    onQueue: () => void = () => actions.enqueue(track),
  ) => (
    <BrowserTrackRow
      title={track.title}
      subtitle={track.artist}
      cover={trackCover(track)}
      seed={track.id}
      active={isPlayingTrack(track)}
      queued={isQueuedTrack(track)}
      onPlay={routeMode() ? () => placeTrack(track) : sourceMode() ? () => sourceTrack(track) : onPlay}
      onQueue={onQueue}
      onMenu={(event) => openTrackActions(track, event)}
      track={track}
      onCarryTrack={props.onCarryTrack}
      hideSecondary={autoNeutral() || routeMode() || sourceMode()}
    />
  );

  return (
    <aside
      class={styles.panel}
      aria-label={routeMode() ? t('autoMode.dj.routePanelAria') : t('nowPlayingBrowser.aria')}
      data-purpose={props.purpose}
    >
      <header class={styles.topbar}>
        {props.dragHandle}
        <div class={styles.search}>
          <button
            class={styles.scopeButton}
            type="button"
            aria-label={routeMode() ? t('autoMode.dj.searchPlaceholder') : scope() === 'library' ? t('nowPlayingBrowser.globalSearch') : t('nowPlayingBrowser.search')}
            onClick={() => !routeMode() && scope() === 'library' && leaveLibrarySearch()}
          >
            <Show
              when={!routeMode() && scope() === 'library'}
              fallback={<SearchIcon />}
            >
              <BackIcon />
            </Show>
          </button>
          <input
            ref={inputEl}
            type="search"
            value={query()}
            placeholder={routeMode() ? t('autoMode.dj.searchPlaceholder') : scope() === 'library' ? t('nowPlayingBrowser.searchLibrary') : t('nowPlayingBrowser.searchGlobal')}
            aria-label={routeMode() ? t('autoMode.dj.searchPlaceholder') : scope() === 'library' ? t('nowPlayingBrowser.searchLibrary') : t('nowPlayingBrowser.searchGlobal')}
            onInput={(event) => onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query()) clear();
            }}
          />
          <Show when={query()}>
            <button class={styles.clear} type="button" aria-label={t('searchPanel.clear')} onClick={clear}>
              <CloseIcon />
            </button>
          </Show>
        </div>
        <button class={styles.close} type="button" aria-label={t('searchPanel.closePanel')} onClick={props.onClose}>
          <CloseIcon />
        </button>
      </header>

      <Switch>
        <Match when={localSearching()}>
          <LocalSearchView
            results={localResults()}
            query={query()}
            onArtist={(name) => push({ kind: 'libraryArtist', name }, true)}
            renderTrack={renderTrack}
            onSearchGlobal={() => {
              const value = query();
              setScope('global');
              runSearch(value);
            }}
            onUse={sourceMode() ? (tracks) => actions.addAutoSource(tracks, query()) : undefined}
          />
        </Match>
        <Match when={globalSearching()}>
          <GlobalSearchView
            sections={panelSections()}
            top={topResult()}
            youtube={ytResults()}
            direct={direct()}
            loading={loading() || ytLoading()}
            failed={failed()}
            resolving={resolving()}
            onRetry={() => runSearch(query())}
            primaryLabel={routeMode() ? t('autoMode.dj.routeAction') : sourceMode() ? t('autoMode.source.title') : undefined}
            hideSecondary={autoNeutral() || routeMode() || sourceMode()}
            onTrack={(item) => void useItem(item, routeMode() ? placeTrack : sourceMode() ? sourceTrack : actions.playNow)}
            onQueue={(item) => void useItem(item, actions.enqueue)}
            onEntity={(item) => {
              if (item.type === 'artist') {
                push({
                  kind: 'catalogArtist',
                  name: itemArtist(item) || item.title,
                  deezerId: item.external_ids?.deezer_artist_id
                    ? String(item.external_ids.deezer_artist_id)
                    : undefined,
                }, true);
              } else if (item.type === 'album') {
                push({
                  kind: 'catalogAlbum',
                  name: item.title,
                  artist: itemArtist(item),
                  deezerId: item.external_ids?.deezer_album_id
                    ? String(item.external_ids.deezer_album_id)
                    : undefined,
                }, true);
              }
            }}
            onYoutube={(result) => routeMode() ? placeTrack(resultTrack(result)) : sourceMode() ? sourceTrack(resultTrack(result)) : actions.playNow(resultTrack(result))}
            onCarryTrack={props.onCarryTrack}
          />
        </Match>
        <Match when={true}>
          <Switch>
            <Match when={currentView().kind === 'root'}>
              <RootView
                libraryCount={musicLibrary().length}
                favouriteCount={favourites().length}
                playlistCount={playlistNames().length}
                showListenNow={!props.purpose?.startsWith('auto-')}
                canRadio={!autoNeutral() && !!currentMusic()}
                canSurprise={!autoNeutral() && surprisePool().length > 0}
                onLibrary={() => push({ kind: 'library' })}
                onFavourites={() => push({ kind: 'favourites' })}
                onPlaylists={() => push({ kind: 'playlists' })}
                onRadio={() => {
                  const current = currentMusic();
                  if (current) void actions.startRadio(current);
                }}
                onSurprise={() => {
                  const pool = surprisePool();
                  if (pool.length) void actions.startRadio(pool[Math.floor(Math.random() * pool.length)]);
                }}
              />
            </Match>
            <Match when={currentView().kind === 'library'}>
              <LibraryView
                tracks={libraryTracks()}
                artists={libraryArtists()}
                onBack={back}
                onSearch={activateLibrarySearch}
                onArtist={(name) => push({ kind: 'libraryArtist', name })}
                renderTrack={renderTrack}
                onUse={sourceMode() ? (tracks) => actions.addAutoSource(tracks, t('nav.library')) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'favourites'}>
              <TrackCollectionView
                title={t('nav.favourites')}
                tracks={favourites()}
                empty={t('favourites.empty')}
                context={{ id: 'favourites', kind: 'favourites', label: t('nav.favourites') }}
                onBack={back}
                renderTrack={renderTrack}
                showPlayAll={!routeMode()}
                onUse={sourceMode() ? (tracks) => actions.addAutoSource(tracks, t('nav.favourites')) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'libraryArtist'}>
              <LibraryArtistView
                name={(currentView() as Extract<BrowserView, { kind: 'libraryArtist' }>).name}
                onBack={back}
                renderTrack={renderTrack}
                onUse={sourceMode() ? (tracks) => actions.addAutoSource(tracks, (currentView() as Extract<BrowserView, { kind: 'libraryArtist' }>).name) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'playlists'}>
              <PlaylistsView names={playlistNames()} byId={byId()} onBack={back} onOpen={(name) => push({ kind: 'playlist', name })} />
            </Match>
            <Match when={currentView().kind === 'playlist'}>
              <PlaylistView
                name={(currentView() as Extract<BrowserView, { kind: 'playlist' }>).name}
                byId={byId()}
                onBack={back}
                renderTrack={renderTrack}
                showPlayAll={!routeMode()}
                onUse={sourceMode() ? (tracks) => actions.addAutoSource(tracks, (currentView() as Extract<BrowserView, { kind: 'playlist' }>).name) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'catalogArtist'}>
              <CatalogArtistView
                view={currentView() as Extract<BrowserView, { kind: 'catalogArtist' }>}
                onBack={back}
                onAlbum={(name, artist, deezerId) => push({ kind: 'catalogAlbum', name, artist, deezerId })}
                sourceMode={sourceMode()}
                routeMode={routeMode()}
                hideSecondary={autoNeutral()}
                onSourceItem={(item) => void useItem(item, sourceTrack)}
                onRouteItem={(item) => void useItem(item, placeTrack)}
              />
            </Match>
            <Match when={currentView().kind === 'catalogAlbum'}>
              <CatalogAlbumView
                view={currentView() as Extract<BrowserView, { kind: 'catalogAlbum' }>}
                onBack={back}
                sourceMode={sourceMode()}
                routeMode={routeMode()}
                hideSecondary={autoNeutral()}
                onSourceItem={(item) => void useItem(item, sourceTrack)}
                onRouteItem={(item) => void useItem(item, placeTrack)}
              />
            </Match>
          </Switch>
        </Match>
      </Switch>
    </aside>
  );
}

function RootView(props: {
  libraryCount: number;
  favouriteCount: number;
  playlistCount: number;
  showListenNow: boolean;
  canRadio: boolean;
  canSurprise: boolean;
  onLibrary: () => void;
  onFavourites: () => void;
  onPlaylists: () => void;
  onRadio: () => void;
  onSurprise: () => void;
}) {
  return (
    <div class={styles.body}>
      <section class={styles.rootNav}>
        <NavigationCard icon={<LibraryIcon />} title={t('nav.library')} meta={`${props.libraryCount}`} onClick={props.onLibrary} />
        <NavigationCard icon={<HeartIcon />} title={t('nav.favourites')} meta={`${props.favouriteCount}`} onClick={props.onFavourites} />
        <NavigationCard icon={<PlaylistIcon />} title={t('nav.playlists')} meta={`${props.playlistCount}`} onClick={props.onPlaylists} />
      </section>
      <Show when={props.showListenNow}>
        <section class={styles.section}>
          <h2>{t('nowPlayingBrowser.listenNow')}</h2>
          <div class={styles.quickGrid}>
            <QuickAction title={t('searchPanel.radioTile')} icon={<RadioIcon />} disabled={!props.canRadio} onClick={props.onRadio} />
            <QuickAction title={t('searchPanel.surpriseTile')} icon={<ShuffleIcon />} disabled={!props.canSurprise} onClick={props.onSurprise} />
          </div>
        </section>
      </Show>
      <section class={styles.section}>
        <div class={styles.sectionHead}>
          <h2>{t('discoverNodes.title')}</h2>
          <button type="button" aria-label={t('discoverNodes.refresh')} disabled={nodeLoading()} onClick={refreshNodeFeed}>
            <RefreshIcon spinning={nodeLoading()} />
          </button>
        </div>
        <Show when={!nodeLoading() || nodeFeed().length > 0} fallback={<SkeletonRows count={4} />}>
          <For each={nodeFeed().slice(0, 4)}>
            {(result) => {
              const track = resultTrack(result);
              return (
                <BrowserTrackRow
                  title={track.title}
                  subtitle={track.artist}
                  cover={track.cover}
                  seed={track.id}
                  active={isPlayingTrack(track)}
                  queued={isQueuedTrack(track)}
                  onPlay={() => actions.playNow(track)}
                  onQueue={() => actions.enqueue(track)}
                  onMenu={(event) => openTrackMenu(track, {}, event)}
                />
              );
            }}
          </For>
        </Show>
      </section>
    </div>
  );
}

function LibraryView(props: {
  tracks: Track[];
  artists: ReturnType<typeof buildArtists>;
  onBack: () => void;
  onSearch: () => void;
  onArtist: (name: string) => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onUse?: (tracks: Track[]) => void;
}) {
  const sort = () =>
    openActionMenu({
      title: t('library.sortTitle'),
      actions: [
        ['recent', t('library.sortRecent')],
        ['az', t('library.sortAZ')],
        ['fav', t('library.sortFavFirst')],
      ].map(([value, label]) => ({
        label: `${librarySort() === value ? '✓  ' : ''}${label}`,
        onSelect: () => setLibrarySort(value),
      })),
    });
  // The panel body is the scrolling element; rows inside it are virtualized
  // because a full library used to build every row up front. A signal, not a
  // plain ref: the rows render inside this element, so they are created before
  // it is assigned and have to react when it appears.
  const [scrollRef, setScrollRef] = createSignal<HTMLElement | null>(null);
  return (
    <div class={styles.body} ref={setScrollRef}>
      <ViewHeader title={t('nav.library')} onBack={props.onBack}>
        <Show when={props.onUse}>
          <button type="button" disabled={!props.tracks.length} onClick={() => props.onUse?.(props.tracks)}>{t('autoMode.source.add')}</button>
        </Show>
        <button type="button" aria-label={t('nowPlayingBrowser.searchLibrary')} onClick={props.onSearch}><SearchIcon /></button>
      </ViewHeader>
      <div class={styles.tabs}>
        <button classList={{ [styles.activeTab]: libraryTab() === 'songs' }} type="button" onClick={() => setLibraryTab('songs')}>{t('library.songs')}</button>
        <button classList={{ [styles.activeTab]: libraryTab() === 'artists' }} type="button" onClick={() => setLibraryTab('artists')}>{t('library.artists')}</button>
        <Show when={libraryTab() === 'songs'}>
          <button class={styles.sort} type="button" aria-label={t('library.sortTitle')} onClick={sort}><SortIcon /></button>
        </Show>
      </div>
      <Show
        when={libraryTab() === 'songs'}
        fallback={
          <VirtualRows
            items={props.artists}
            scrollElement={scrollRef}
            rowHeight={{ cssVar: '--row-h', fallback: 56 }}
          >
            {(artist) => {
              const row = artist();
              return row ? (
                <NavigationRow
                  title={row.name}
                  subtitle={t('library.artistTrackCount', { count: row.count })}
                  cover={coverUrl(row.coverId)}
                  round
                  onClick={() => props.onArtist(row.name)}
                />
              ) : null;
            }}
          </VirtualRows>
        }
      >
        <VirtualRows
          items={props.tracks}
          scrollElement={scrollRef}
          rowHeight={{ cssVar: '--row-h', fallback: 56 }}
        >
          {(track, index) => {
            const row = track();
            return row
              ? props.renderTrack(row, () =>
                  actions.playFrom(props.tracks, index, { context: { id: 'library', kind: 'library', label: t('nav.library') } }),
                )
              : null;
          }}
        </VirtualRows>
      </Show>
    </div>
  );
}

function LibraryArtistView(props: {
  name: string;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onUse?: (tracks: Track[]) => void;
}) {
  const tracks = createMemo(() =>
    musicLibrary().filter((track) =>
      artistKey(track.artist) === artistKey(props.name) || artistKey(track.album_artist) === artistKey(props.name),
    ),
  );
  const [scrollRef, setScrollRef] = createSignal<HTMLElement | null>(null);
  return (
    <div class={styles.body} ref={setScrollRef}>
      <ViewHeader title={props.name} meta={`${tracks().length}`} onBack={props.onBack}>
        <Show when={props.onUse}><button type="button" disabled={!tracks().length} onClick={() => props.onUse?.(tracks())}>{t('autoMode.source.add')}</button></Show>
      </ViewHeader>
      <VirtualRows
        items={tracks()}
        scrollElement={scrollRef}
        rowHeight={{ cssVar: '--row-h', fallback: 56 }}
      >
        {(track, index) => {
          const row = track();
          return row
            ? props.renderTrack(row, () =>
                actions.playFrom(tracks(), index, { context: { id: `artist:${props.name}`, kind: 'artist', label: props.name } }),
              )
            : null;
        }}
      </VirtualRows>
    </div>
  );
}

function LocalSearchView(props: {
  results: LibrarySearchResult[];
  query: string;
  onArtist: (name: string) => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onSearchGlobal: () => void;
  onUse?: (tracks: Track[]) => void;
}) {
  const tracks = createMemo(() => props.results.flatMap((result) => result.kind === 'track' ? [result.track] : []));
  return (
    <div class={styles.body}>
      <ViewHeader title={t('nowPlayingBrowser.libraryResults')} meta={`${props.results.length}`}>
        <Show when={props.onUse}><button type="button" disabled={!tracks().length} onClick={() => props.onUse?.(tracks())}>{t('autoMode.source.add')}</button></Show>
      </ViewHeader>
      <For each={props.results}>
        {(result) => result.kind === 'artist'
          ? <NavigationRow title={result.artist.name} subtitle={t('library.artistTrackCount', { count: result.artist.count })} cover={coverUrl(result.artist.coverId)} round onClick={() => props.onArtist(result.artist.name)} />
          : props.renderTrack(result.track, () => actions.playFrom(
              tracks(),
              Math.max(0, tracks().findIndex((track) => track.id === result.track.id)),
              { context: { id: 'library-search', kind: 'search', label: t('library.searchLibrary') } },
            ))}
      </For>
      <div class={styles.searchEverywhere}>
        <Show when={props.results.length === 0}>
          <p>{t('library.noSearchResults')}</p>
        </Show>
        <button type="button" onClick={props.onSearchGlobal}>{t('nowPlayingBrowser.searchEverywhere', { query: props.query })}</button>
      </div>
    </div>
  );
}

function PlaylistsView(props: {
  names: string[];
  byId: Map<string, Track>;
  onBack: () => void;
  onOpen: (name: string) => void;
}) {
  return (
    <div class={styles.body}>
      <ViewHeader title={t('nav.playlists')} meta={`${props.names.length}`} onBack={props.onBack} />
      <For each={props.names}>
        {(name) => {
          const ids = () => state.playlists[name] ?? [];
          const coverId = () => pickPlaylistCoverId(name, ids(), props.byId, state.librarySettings);
          return <NavigationRow title={name} subtitle={`${ids().length}`} cover={coverId() ? coverUrl(coverId()!) : undefined} onClick={() => props.onOpen(name)} />;
        }}
      </For>
    </div>
  );
}

function PlaylistView(props: {
  name: string;
  byId: Map<string, Track>;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  showPlayAll: boolean;
  onUse?: (tracks: Track[]) => void;
}) {
  const tracks = createMemo(() =>
    (state.playlists[props.name] ?? []).map((id) => props.byId.get(id)).filter((track): track is Track => !!track),
  );
  return (
    <TrackCollectionView
      title={props.name}
      tracks={tracks()}
      empty={t('playlistDetail.empty')}
      context={{ id: `playlist:${props.name}`, kind: 'playlist', label: props.name }}
      onBack={props.onBack}
      renderTrack={props.renderTrack}
      showPlayAll={props.showPlayAll}
      onUse={props.onUse}
    />
  );
}

function TrackCollectionView(props: {
  title: string;
  tracks: Track[];
  empty: string;
  context: PlaybackContextDescriptor;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  showPlayAll: boolean;
  onUse?: (tracks: Track[]) => void;
}) {
  return (
    <div class={styles.body}>
      <ViewHeader title={props.title} meta={`${props.tracks.length}`} onBack={props.onBack}>
        <Show when={props.onUse}>
          <button type="button" disabled={!props.tracks.length} onClick={() => props.onUse?.(props.tracks)}>{t('autoMode.source.add')}</button>
        </Show>
        <Show when={!props.onUse && props.showPlayAll}>
          <button type="button" disabled={props.tracks.length === 0} aria-label={t('playlistDetail.play')} onClick={() =>
            actions.playFrom(props.tracks, 0, { context: props.context })
          }><PlayIcon /></button>
        </Show>
      </ViewHeader>
      <Show when={props.tracks.length > 0} fallback={<div class={styles.empty}><p>{props.empty}</p></div>}>
        <For each={props.tracks}>
          {(track, index) => props.renderTrack(track, () =>
            actions.playFrom(props.tracks, index(), { context: props.context }),
          )}
        </For>
      </Show>
    </div>
  );
}

function GlobalSearchView(props: {
  sections: ResolvedSection[];
  top: CatalogItem | null;
  youtube: SearchResult[];
  direct: SearchResult | null;
  loading: boolean;
  failed: boolean;
  resolving: Set<string>;
  onRetry: () => void;
  onTrack: (item: CatalogItem) => void;
  onQueue: (item: CatalogItem) => void;
  onEntity: (item: CatalogItem) => void;
  onYoutube: (result: SearchResult) => void;
  primaryLabel?: string;
  hideSecondary?: boolean;
  onCarryTrack?: (track: Track) => void;
}) {
  const empty = () => props.sections.every((section) => section.items.length === 0);
  // The panel is a list, not a page: the server's *order* applies, its grid and
  // hero layouts do not.
  const row = (item: CatalogItem) =>
    item.type === 'artist' || item.type === 'album' || item.type === 'playlist' ? (
      <NavigationRow
        title={item.title}
        subtitle={item.type === 'artist' ? t('searchPanel.chipArtist') : `${t('searchPanel.chipAlbum')} · ${itemArtist(item)}`}
        cover={item.cover}
        round={item.type === 'artist'}
        onClick={() => props.onEntity(item)}
      />
    ) : (
      <BrowserTrackRow
        title={item.title}
        subtitle={item.subtitle || itemArtist(item)}
        cover={item.cover || (item.track_id ? coverUrl(item.track_id) : undefined)}
        seed={item.id}
        active={isPlayingItem(item)}
        queued={isQueuedItem(item)}
        resolving={props.resolving.has(item.id)}
        owned={item.type === 'library_track' || !!ownedTrackForItem(item)}
        primaryLabel={props.primaryLabel}
        hideSecondary={props.hideSecondary}
        onPlay={() => props.onTrack(item)}
        onQueue={() => props.onQueue(item)}
        track={playableTrack(item) ?? undefined}
        onCarryTrack={props.onCarryTrack}
      />
    );

  return (
    <div class={styles.body} aria-busy={props.loading}>
      <Show when={props.loading && empty() && props.youtube.length === 0 && !props.direct}>
        <SkeletonRows count={8} />
      </Show>
      <Show when={props.top}>{(item) => row(item())}</Show>
      <For each={props.sections}>
        {(section) => <For each={section.items}>{(item) => row(item)}</For>}
      </For>
      <Show when={props.direct}>
        {(result) => <YoutubeRow result={result()} onPlay={() => props.onYoutube(result())} primaryLabel={props.primaryLabel} hideSecondary={props.hideSecondary} onCarryTrack={props.onCarryTrack} />}
      </Show>
      <For each={props.youtube}>
        {(result) => <YoutubeRow result={result} onPlay={() => props.onYoutube(result)} primaryLabel={props.primaryLabel} hideSecondary={props.hideSecondary} onCarryTrack={props.onCarryTrack} />}
      </For>
      <Show when={!props.loading && !props.direct && empty() && props.youtube.length === 0}>
        <div class={styles.empty}>
          <p>{props.failed ? t('searchPanel.searchError') : t('searchPanel.noResults')}</p>
          <Show when={props.failed}><button type="button" onClick={props.onRetry}>{t('common.retry')}</button></Show>
        </div>
      </Show>
    </div>
  );
}

function YoutubeRow(props: {
  result: SearchResult;
  onPlay: () => void;
  primaryLabel?: string;
  hideSecondary?: boolean;
  onCarryTrack?: (track: Track) => void;
}) {
  return (
    <BrowserTrackRow
      title={props.result.title}
      subtitle={props.result.channel ?? ''}
      cover={props.result.thumbnail}
      seed={props.result.id}
      active={isPlayingResult(props.result)}
      queued={isQueuedResult(props.result)}
      owned={!!ownedTrackForResult(props.result)}
      primaryLabel={props.primaryLabel}
      hideSecondary={props.hideSecondary}
      onPlay={props.onPlay}
      onQueue={() => actions.enqueue(resultTrack(props.result))}
      onMenu={(event) => openTrackMenu(resultTrack(props.result), {}, event)}
      track={resultTrack(props.result)}
      onCarryTrack={props.onCarryTrack}
    />
  );
}

function CatalogArtistView(props: {
  view: Extract<BrowserView, { kind: 'catalogArtist' }>;
  onBack: () => void;
  onAlbum: (name: string, artist: string, deezerId?: string) => void;
  sourceMode?: boolean;
  routeMode?: boolean;
  hideSecondary?: boolean;
  onSourceItem: (item: CatalogItem) => void;
  onRouteItem: (item: CatalogItem) => void;
}) {
  const [profile] = createResource(
    () => [props.view.name, props.view.deezerId] as const,
    ([name, id]) => api.getArtistProfile(name, id),
  );
  const play = (item: CatalogItem, queue: CatalogItem[]) =>
    void playCatalogItem(item, queue, { id: `artist:${props.view.name}`, kind: 'artist', label: props.view.name });
  return (
    <div class={styles.body}>
      <ViewHeader title={props.view.name} onBack={props.onBack}>
        <button type="button" disabled={!profile()?.top_tracks.length} aria-label={props.sourceMode ? t('autoMode.source.add') : t('artist.play')} onClick={() => {
          const tracks = profile()?.top_tracks ?? [];
          if (props.sourceMode) {
            const resolved = tracks.map(playableTrack).filter((track): track is Track => !!track);
            if (resolved.length) actions.addAutoSource(resolved, props.view.name);
          } else if (tracks[0]) play(tracks[0], tracks);
        }}><PlayIcon /></button>
      </ViewHeader>
      <Show when={!profile.loading} fallback={<SkeletonRows count={8} />}>
        <Show when={profile()} fallback={<div class={styles.empty}>{t('artist.noCatalogData')}</div>}>
          {(data) => (
            <>
              <section class={styles.section}>
                <h2>{t('artist.topTracks')}</h2>
                <For each={data().top_tracks.slice(0, 10)}>
                  {(item) => (
                    <BrowserTrackRow
                      title={item.title}
                      subtitle={itemArtist(item)}
                      cover={item.cover}
                      seed={item.id}
                      active={isPlayingItem(item)}
                      queued={isQueuedItem(item)}
                      onPlay={() => props.routeMode ? props.onRouteItem(item) : props.sourceMode ? props.onSourceItem(item) : play(item, data().top_tracks.slice(0, 10))}
                      onQueue={() => void enqueueCatalogItem(item)}
                      hideSecondary={props.hideSecondary || props.sourceMode || props.routeMode}
                    />
                  )}
                </For>
              </section>
              <section class={styles.section}>
                <h2>{t('artist.albums')}</h2>
                <div class={styles.albumGrid}>
                  <For each={data().albums}>
                    {(album) => {
                      const tap = createResponsiveTap({
                        onTap: () => props.onAlbum(album.title, props.view.name, album.deezer_id),
                      });
                      return (
                        <button type="button" data-pressable {...tap}>
                          <span style={coverStyle(album.title, album.cover)} />
                          <strong>{album.title}</strong>
                          <small>{album.year ?? ''}</small>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </section>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

function CatalogAlbumView(props: {
  view: Extract<BrowserView, { kind: 'catalogAlbum' }>;
  onBack: () => void;
  sourceMode?: boolean;
  routeMode?: boolean;
  hideSecondary?: boolean;
  onSourceItem: (item: CatalogItem) => void;
  onRouteItem: (item: CatalogItem) => void;
}) {
  const [profile] = createResource(
    () => [props.view.name, props.view.artist, props.view.deezerId] as const,
    ([name, artist, id]) => api.getAlbumProfile(name, artist, id),
  );
  const play = (item: CatalogItem, queue: CatalogItem[]) =>
    void playCatalogItem(item, queue, { id: `album:${props.view.name}`, kind: 'album', label: props.view.name });
  return (
    <div class={styles.body}>
      <ViewHeader title={props.view.name} meta={props.view.artist} onBack={props.onBack}>
        <button type="button" disabled={!profile()?.tracklist.length} aria-label={props.sourceMode ? t('autoMode.source.add') : t('album.play')} onClick={() => {
          const tracks = profile()?.tracklist ?? [];
          if (props.sourceMode) {
            const resolved = tracks.map(playableTrack).filter((track): track is Track => !!track);
            if (resolved.length) actions.addAutoSource(resolved, props.view.name);
          } else if (tracks[0]) play(tracks[0], tracks);
        }}><PlayIcon /></button>
      </ViewHeader>
      <Show when={!profile.loading} fallback={<SkeletonRows count={8} />}>
        <Show when={profile()} fallback={<div class={styles.empty}>{t('album.noCatalogData')}</div>}>
          {(data) => (
            <For each={data().tracklist}>
              {(item) => (
                <BrowserTrackRow
                  title={item.title}
                  subtitle={itemArtist(item)}
                  cover={item.cover || data().cover}
                  seed={item.id}
                  active={isPlayingItem(item)}
                  queued={isQueuedItem(item)}
                  onPlay={() => props.routeMode ? props.onRouteItem(item) : props.sourceMode ? props.onSourceItem(item) : play(item, data().tracklist)}
                  onQueue={() => void enqueueCatalogItem(item)}
                  hideSecondary={props.hideSecondary || props.sourceMode || props.routeMode}
                />
              )}
            </For>
          )}
        </Show>
      </Show>
    </div>
  );
}

function ViewHeader(props: { title: string; meta?: string; onBack?: () => void; children?: JSX.Element }) {
  return (
    <header class={styles.viewHeader}>
      <Show when={props.onBack}>
        <button type="button" aria-label={t('common.back')} onClick={props.onBack}><BackIcon /></button>
      </Show>
      <div><h1>{props.title}</h1><Show when={props.meta}><span>{props.meta}</span></Show></div>
      <div class={styles.viewActions}>{props.children}</div>
    </header>
  );
}

function NavigationCard(props: { icon: JSX.Element; title: string; meta: string; onClick: () => void }) {
  const tap = createResponsiveTap({ onTap: props.onClick });
  return <button class={styles.navCard} type="button" data-pressable {...tap}><span>{props.icon}</span><strong>{props.title}</strong><small>{props.meta}</small><ChevronIcon /></button>;
}

function NavigationRow(props: { title: string; subtitle: string; cover?: string; round?: boolean; onClick: () => void }) {
  const tap = createResponsiveTap({ onTap: props.onClick });
  return (
    <button class={styles.navRow} type="button" data-pressable {...tap}>
      <span classList={{ [styles.round]: props.round }} style={coverStyle(props.title, props.cover)} />
      <span><strong>{props.title}</strong><small>{props.subtitle}</small></span>
      <ChevronIcon />
    </button>
  );
}

function QuickAction(props: { title: string; icon: JSX.Element; disabled: boolean; onClick: () => void }) {
  const tap = createResponsiveTap({
    disabled: () => props.disabled,
    onTap: props.onClick,
  });
  return <button class={styles.quick} type="button" disabled={props.disabled} data-pressable {...tap}><span>{props.icon}</span><strong>{props.title}</strong></button>;
}

function BrowserTrackRow(props: {
  title: string;
  subtitle: string;
  cover?: string;
  seed: string;
  active: boolean;
  queued: boolean;
  resolving?: boolean;
  owned?: boolean;
  onPlay: () => void;
  onQueue: () => void;
  onMenu?: (event: MouseEvent) => void;
  primaryLabel?: string;
  hideSecondary?: boolean;
  track?: Track;
  onCarryTrack?: (track: Track) => void;
}) {
  const tap = createResponsiveTap({ onTap: props.onPlay });
  let holdTimer: number | undefined;
  const cancelHold = () => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  };
  return (
    <div
      classList={{ [styles.trackRow]: true, [styles.trackActive]: props.active }}
      draggable={Boolean(props.track)}
      onDragStart={(event) => props.track && writeAutoTrackTransfer(event, { track: props.track })}
      onPointerDown={() => {
        if (!props.track || !props.onCarryTrack) return;
        cancelHold();
        holdTimer = window.setTimeout(() => props.onCarryTrack?.(props.track!), 460);
      }}
      onPointerMove={cancelHold}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={(event) => {
      if (!props.onMenu) return;
      event.preventDefault();
      props.onMenu(event);
    }}>
      <button class={styles.trackMain} type="button" aria-label={props.primaryLabel ? `${props.primaryLabel}: ${props.title}` : undefined} data-pressable {...tap}>
        <span class={styles.trackCover} style={coverStyle(props.seed, props.cover)} />
        <span class={styles.trackMeta}><strong>{props.title}</strong><small>{props.subtitle}</small></span>
      </button>
      <Show when={props.resolving}><Spinner size={14} /></Show>
      <Show when={props.owned || props.queued}><span class={styles.check}>✓</span></Show>
      <Show when={!props.hideSecondary}>
        <button class={styles.rowAction} type="button" aria-label={t('searchPanel.ariaAddQueue')} onClick={props.onQueue}><QueueIcon /></button>
      </Show>
      <Show when={props.onMenu && !props.hideSecondary}><button class={styles.rowAction} type="button" aria-label={t('common.more')} onClick={(event) => props.onMenu?.(event)}>•••</button></Show>
    </div>
  );
}

const icon = (path: JSX.Element) => <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
const SearchIcon = () => icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>);
const BackIcon = () => icon(<path d="m15 18-6-6 6-6" />);
const CloseIcon = () => icon(<path d="m7 7 10 10M17 7 7 17" />);
const ChevronIcon = () => icon(<path d="m9 18 6-6-6-6" />);
const LibraryIcon = () => icon(<><path d="M5 4h14v16H5z" /><path d="M9 4v16" /></>);
const HeartIcon = () => icon(<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />);
const PlaylistIcon = () => icon(<><path d="M4 6h16M4 12h16M4 18h10" /><path d="M18 15v6M21 18h-6" /></>);
const RadioIcon = () => icon(<><path d="M4 12a8 8 0 0 1 8-8M4 12a8 8 0 0 0 8 8M8 12a4 4 0 0 1 4-4" /><circle cx="12" cy="12" r="1.5" /></>);
const ShuffleIcon = () => icon(<><path d="M4 5h3l10 14h3M17 5h3v3M4 19h3l3-4M14 9l3-4h3" /></>);
const SortIcon = () => icon(<path d="M4 7h16M7 12h10M10 17h4" />);
const PlayIcon = () => icon(<path d="m8 5 11 7-11 7z" />);
const QueueIcon = () => icon(<><path d="M3 6h13M3 12h9M3 18h9M16 14v6M19 17h-6" /></>);
const RefreshIcon = (props: { spinning: boolean }) => <span classList={{ [styles.spinning]: props.spinning }}>{icon(<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />)}</span>;
