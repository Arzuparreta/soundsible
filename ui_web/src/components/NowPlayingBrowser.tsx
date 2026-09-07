import { mobileListLayout } from '../lib/listLayout';
import { MusicListRow } from './MusicListRow';
import { savedFromTrack, savedFromCatalogItem } from '../lib/saved';
import type { SavedEntry } from '../types/music';
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  ErrorBoundary,
  Match,
  onCleanup,
  untrack,
  useContext,
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
import { coverUrl, trackCoverUrl } from '../lib/media';
import { coverStyle } from '../lib/cover';
import { parseYouTubeInput } from '../lib/youtube';
import { ensureNodeFeed, nodeFeed, nodeLoading, refreshNodeFeed } from '../lib/nodeDiscover';
import { albumSort, albumFilter, filterTracks, libraryFilter, setLibraryFilter, catalogArtists, librarySort, libraryTab, setLibrarySort, setLibraryTab, sortTracks } from '../lib/libraryView';
import { artistKey } from '../lib/artistRoute';
import { normalizeLibraryQuery, searchLibrary, type LibrarySearchResult } from '../lib/librarySearch';
import { resolveCatalogTrack, catalogPreviewId, itemArtist, itemToTrack, playCatalogItem } from '../lib/catalogItem';
import { writeAutoTrackTransfer } from '../lib/autoMusicTransfer';
import { catalogItemKeys } from '../lib/playbackIdentity';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { prefetchPreviews } from '../lib/prefetch';
import { isPodcastTrack } from '../lib/track';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { openActionMenu } from './ActionMenu';
import { VirtualRows } from './VirtualRows';
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
import type { CatalogAlbum, CatalogItem, CatalogSection, SearchResult, Track } from '../types/music';
import { musicBrowserNavigation as navigation, type BrowserView, type BrowserSection, type SearchScope, type ResultType } from '../lib/musicBrowserNavigation';
import { tracksByIds } from '../lib/catalogTracks';
import { albumBrowseQuery, collateAlbums } from '../lib/albumBrowse';
import { createPlaylistDialog, openPlaylistMenu } from './playlistActions';
import { CollectionActions, CollectionPlacementContext } from './CollectionActions';
import SongRow from './SongRow';
import { openAlbumBrowseMenu } from './albumBrowseMenu';
import { ViewHeader as SharedViewHeader } from './ViewHeader';
import { MusicReorderList } from './MusicReorderList';
import styles from './NowPlayingBrowser.module.css';
export type { BrowserView } from '../lib/musicBrowserNavigation';

/** What a song row needs to know about the session it is being listed inside.
 * Built once per row by `NowPlayingBrowser.autoRow` and handed down, so every
 * list gets the same behaviour without repeating the reasoning. */
interface AutoRowProps {
  entry?: SavedEntry;
  favouritesKnown?: boolean;
  variant: 'browse' | 'auto';
  primaryLabel?: string;
  onAddToRoute?: () => void;
  onMenu?: (event?: MouseEvent) => void;
  track?: Track;
  onCarryTrack?: (track: Track) => void;
}

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
  try {
    const track = await resolveCatalogTrack(item);
    if (!track) throw new Error('unresolved');
    actions.enqueue(track);
  } catch {
    toast.error(t('searchPanel.noResolve'));
  }
}

/** How long a restore may keep a panel's scroll position under its own control
 * before handing it back to whoever is reading. */
const RESTORE_GRACE_MS = 1500;

export function NowPlayingBrowser(props: {
  onClose: () => void;
  dragHandle?: JSX.Element;
  purpose?: 'browse' | 'auto-neutral' | 'auto-route' | 'auto-reference';
  active?: boolean;
  routeBeforeQueueId?: string;
  onPlaced?: () => void;
  onCarryTrack?: (track: Track) => void;
}) {
  let resetContentError: (() => void) | undefined;
  const routeMode = () => props.purpose === 'auto-route';
  const inAuto = () => Boolean(props.purpose?.startsWith('auto-'));
  const currentView = createMemo(() => navigation.current().view);
  const scope = createMemo(() => navigation.current().scope);
  const setScope = (value: SearchScope) => navigation.update({ scope: value });
  const query = createMemo(() => navigation.current().query);
  const setQuery = (value: string) => navigation.update({ query: value, scroll: 0 });
  const filter = createMemo(() => navigation.current().filter);
  const [partial, setPartial] = createSignal(false);
  const referenceMode = () => props.purpose === 'auto-reference';
  let panelEl: HTMLElement | undefined;
  let restoringScroll = false;
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
    sortTracks(filterTracks(musicLibrary(), libraryFilter()), librarySort(), new Set(favouriteLibraryIds())),
  );
  const favourites = createMemo(() => favouriteTracks().filter((track) => !isPodcastTrack(track)));
  const libraryArtists = createMemo(() => catalogArtists(state.catalog.artists));
  const localResults = createMemo(() =>
    scope() === 'library' ? searchLibrary(libraryTracks(), libraryArtists(), query()) : [],
  );
  const [searchAlbums, { refetch: refetchSearchAlbums }] = createResource(() => props.active !== false && scope() === 'library' && query().trim() ? state.catalog.revision : false, () => api.getLibraryAlbums());
  const localAlbums = createMemo(() => (searchAlbums() ?? []).filter((album) => normalizeLibraryQuery(`${album.title} ${album.album_artist}`).includes(normalizeLibraryQuery(query()))));
  const globalSearching = createMemo(() => scope() !== 'library' && query().trim().length >= 2);
  const localSearching = createMemo(() => scope() === 'library' && query().trim().length > 0);
  // The panel used to render entities first and then songs, while the Search
  // route rendered songs first and then entities — two hardcoded orders, both
  // wrong in the other's case. Both now follow the one the server sends.
  const resolved = createMemo(() => resolveSections(items(), sections()));
  const matchingPlaylists = createMemo(() => {
    const q = normalizeLibraryQuery(query());
    return q ? Object.keys(state.playlists).filter((name) => normalizeLibraryQuery(name).includes(q)) : [];
  });
  const topResult = createMemo(() => filter() === 'all' ? topResultItem(resolved()) : null);
  const panelSections = createMemo<ResolvedSection[]>(() => {
    const sections = resolved().filter((row) => row.id !== 'top');
    if (filter() === 'all') return sections;
    const top = topResultItem(resolved());
    const type = filter() === 'songs' ? ['track', 'library_track'] : [filter().slice(0, -1)];
    const rows = sections.flatMap((row) => row.items).filter((item) => type.includes(item.type));
    if (top && type.includes(top.type) && !rows.some((item) => item.id === top.id)) rows.unshift(top);
    return rows.length ? [{ id: filter(), items: rows, layout: 'rows', total: rows.length }] : [];
  });
  createEffect(() => {
    currentView(); query(); scope();
    const reset = resetContentError;
    resetContentError = undefined;
    reset?.();
  });
  const playlistNames = createMemo(() => Object.keys(state.playlists));
  const byId = createMemo(() => new Map(musicLibrary().map((track) => [track.id, track] as const)));
  const savePosition = () => {
    const body = panelEl?.querySelector<HTMLElement>('[data-browser-body]');
    if (body && props.active !== false && !restoringScroll) navigation.update({ scroll: body.scrollTop });
  };
  const push = (view: BrowserView, _returnToSearch = false) => { savePosition(); clearTimeout(debounce); clearSearchState(); navigation.push(view); };
  const back = () => { savePosition(); clearTimeout(debounce); clearSearchState(); navigation.back(); };
  const selectSection = (section: BrowserSection) => { savePosition(); clearTimeout(debounce); clearSearchState(); navigation.select(section); };
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

    if (scope() === 'library' || q.length < 2) {
      setLoading(false);
      setYtLoading(false);
      return;
    }
    aborter = new AbortController();
    const signal = aborter.signal;
    setPartial(false);
    if (scope() === 'youtube') {
      setYtLoading(true);
      api.searchYouTube(q, signal).then((rows) => { if (request === requestId) setYtResults(rows); })
        .catch((error) => { if (!isAbort(error) && request === requestId) setFailed(true); })
        .finally(() => { if (request === requestId) setYtLoading(false); });
      return;
    }
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
        setPartial(Boolean(response.partial_failures?.length));
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
    clearSearchState();
    setQuery(value);
    setLoading(scope() !== 'library' && value.trim().length >= 2);

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

  const useItem = async (item: CatalogItem, action: (track: Track) => void) => {
    if (resolving().has(item.id)) return;
    const purpose = props.purpose;
    const before = props.routeBeforeQueueId;
    const epoch = inAuto() ? actions.autoSessionToken() : null;
    markResolving(item.id, true);
    try {
      const track = await resolveCatalogTrack(item);
      if (!track) throw new Error('unresolved');
      if (props.purpose !== purpose || props.routeBeforeQueueId !== before || (epoch !== null && actions.autoSessionToken() !== epoch)) return;
      action(track);
    } catch {
      toast.error(t('searchPanel.noResolve'));
    } finally {
      markResolving(item.id, false);
    }
  };

  const placeTrack = (track: Track) => {
    if (referenceMode()) actions.useAutoTrackAsSource(track);
    else void actions.placeAutoTrack(track, props.routeBeforeQueueId);
    // Only a placement aimed at a seam is a finished errand. Adding from
    // ordinary browsing leaves the listener where they are, free to add more —
    // bouncing them to the route after every song made building a set a chore.
    if (routeMode() || referenceMode()) props.onPlaced?.();
  };
  /**
   * The Auto-Mode half of a song row, for anything the panel can list.
   *
   * A catalog entry has to be resolved to something playable before it can be
   * placed, which is why this accepts either shape. Every list routes through
   * here, so "add to the route" reaches library, favourites, playlists, local
   * and global search, artist pages, album pages and the discover rail alike —
   * rather than only the handful of call sites that happened to pass the right
   * props.
   */
  const autoRow = (target: Track | CatalogItem | null): AutoRowProps => {
    // `type` is what a catalog entry has and a track does not.
    const item = target && 'type' in target ? target : null;
    const track = item ? playableTrack(item) : (target as Track | null);
    const auto = Boolean(props.purpose?.startsWith('auto-'));
    return {
      entry: item ? savedFromCatalogItem(item) : track ? savedFromTrack(track) : undefined,
      favouritesKnown: !query().trim() && currentView().kind === 'favourites',
      variant: auto ? 'auto' : 'browse',
      primaryLabel: referenceMode() ? t('musicExplorer.reference') : auto ? t('musicExplorer.request') : undefined,
      onAddToRoute: auto && target
        ? () => item ? void useItem(item, placeTrack) : placeTrack(target as Track)
        : undefined,
      onMenu: target ? (event) => item ? void useItem(item, (resolved) => openTrackActions(resolved, event)) : openTrackActions(target as Track, event) : undefined,
      track: track ?? undefined,
      onCarryTrack: props.onCarryTrack,
    };
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
      onOpenArtist: track.artist ? () => push({ kind: 'catalogArtist', name: track.artist }) : undefined,
      onOpenAlbum: track.album ? () => push({ kind: 'catalogAlbum', name: track.album!, artist: track.album_artist || track.artist }) : undefined,
      onRemoveFromPlaylist: currentView().kind === 'playlist' ? () => void actions.removeFromPlaylist((currentView() as { name: string }).name, track.id) : undefined,
    }, event);

  createEffect(() => {
    const value = query(); const searchScope = scope(); const active = props.active !== false;
    clearTimeout(debounce);
    if (!active) { aborter?.abort(); return; }
    debounce = window.setTimeout(() => { untrack(() => runSearch(value)); }, value ? 230 : 0);
    void searchScope;
  });
  // Restore after asynchronous content and the virtual window have laid out.
  createEffect(() => {
    const view = currentView(); const q = query(); const type = filter(); const active = props.active !== false;
    if (!active || !panelEl) return;
    const offset = untrack(() => navigation.current().scroll);
    restoringScroll = true;
    let frame = 0;
    // A list that is already where it belongs is done, whatever else changes in
    // it. Re-arming on those mutations cancels the frame that would have closed
    // the restore, and a panel whose rows carry live marks never stops mutating
    // — so the restore stayed open, kept yanking the list back to the offset
    // under whoever was reading it, and swallowed the positions they scrolled
    // to, because a scroll is only recorded once the restore has let go.
    const body = () => panelEl?.querySelector<HTMLElement>('[data-browser-body]');
    const atOffset = () => { const el = body(); return !!el && Math.abs(el.scrollTop - offset) <= 1; };
    const observer = new MutationObserver(() => {
      if (atOffset()) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    });
    const finish = () => { restoringScroll = false; observer.disconnect(); };
    // And a position this view can never reach — a shorter list than the one
    // the offset was taken from — must not hold the restore open for good.
    const expiry = window.setTimeout(finish, RESTORE_GRACE_MS);
    onCleanup(() => window.clearTimeout(expiry));
    const restore = () => {
      const el = body();
      if (!el) return;
      el.scrollTop = offset;
      if (Math.abs(el.scrollTop - offset) <= 1) frame = requestAnimationFrame(() => {
        if (atOffset()) finish();
        else restore();
      });
    };
    observer.observe(panelEl, { childList: true, subtree: true });
    panelEl.addEventListener('wheel', finish, { once: true, passive: true });
    panelEl.addEventListener('pointerdown', finish, { once: true, passive: true });
    frame = requestAnimationFrame(restore);
    onCleanup(() => { cancelAnimationFrame(frame); observer.disconnect(); panelEl?.removeEventListener('wheel', finish); panelEl?.removeEventListener('pointerdown', finish); });
    void view; void q; void type;
  });

  const renderTrack = (
    track: Track,
    onPlay: () => void,
    onQueue: () => void = () => actions.enqueue(track),
  ) => (
    <BrowserTrackRow
      title={track.title}
      subtitle={track.artist}
      cover={trackCoverUrl(track)}
      seed={track.id}
      active={isPlayingTrack(track)}
      queued={isQueuedTrack(track)}
      onPlay={inAuto() ? () => placeTrack(track) : onPlay}
      onQueue={onQueue}
      onMenu={(event) => openTrackActions(track, event)}
      {...autoRow(track)}
    />
  );

  return (
    <CollectionPlacementContext.Provider value={{
      get beforeQueueId() { return props.routeBeforeQueueId; },
      get referenceOnly() { return referenceMode(); },
      get intent() { return props.purpose; },
      onCompleted: () => { if (routeMode() || referenceMode()) props.onPlaced?.(); },
    }}><aside
      ref={(element) => {
        panelEl = element;
        const saveScroll = (event: Event) => {
          if (!restoringScroll && props.active !== false && (event.target as HTMLElement).hasAttribute('data-browser-body')) navigation.update({ scroll: (event.target as HTMLElement).scrollTop });
        };
        element.addEventListener('scroll', saveScroll, true);
        onCleanup(() => element.removeEventListener('scroll', saveScroll, true));
      }}
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

      <nav class={styles.destinations} aria-label={t('musicExplorer.title')}>
        <For each={(['library', 'favourites', 'playlists', 'root'] as const)}>{(section) =>
          <button type="button" aria-current={navigation.section() === section ? 'page' : undefined} onClick={() => selectSection(section)}>{section === 'root' ? t('musicExplorer.explore') : t(`nav.${section}`)}</button>
        }</For>
      </nav>
      <Show when={routeMode() || referenceMode()}>
        <div class={styles.intent}><span>{t(referenceMode() ? 'musicExplorer.referencePicking' : 'musicExplorer.placing')}</span><button type="button" onClick={props.onPlaced}>{t('musicExplorer.cancelPlacement')}</button></div>
      </Show>
      <Show when={query().trim() || scope() !== 'global'}><div class={styles.searchFilters}>
        <select aria-label={t('musicExplorer.allMusic')} value={scope()} onChange={(event) => { clearSearchState(); setScope(event.currentTarget.value as SearchScope); }}>
          <option value="global">{t('musicExplorer.allMusic')}</option><option value="library">{t('musicExplorer.libraryOnly')}</option><option value="youtube">YouTube</option>
        </select>
        <Show when={query().trim()}><select aria-label={t('musicExplorer.types')} value={filter()} onChange={(event) => navigation.update({ filter: event.currentTarget.value as ResultType, scroll: 0 })}>
          <For each={(['all', 'songs', 'artists', 'albums', 'playlists'] as const)}>{(type) => <option value={type}>{type === 'all' ? t('musicExplorer.all') : type === 'playlists' ? t('nav.playlists') : t(`library.${type}`)}</option>}</For>
        </select></Show>
      </div></Show>
      <Show when={partial()}><p class={styles.intent} role="status">{t('musicExplorer.partial')}</p></Show>
      <ErrorBoundary fallback={(_error, reset) => { resetContentError = reset; return <div class={styles.empty} role="alert"><p>{t('searchPanel.searchError')}</p><button type="button" onClick={() => { void refetchSearchAlbums(); reset(); }}>{t('common.retry')}</button></div>; }}><Switch>
        <Match when={localSearching()}>
          <LocalSearchView
            albums={filter() === 'all' || filter() === 'albums' ? localAlbums() : []}
            onAlbum={(album) => push({ kind: 'libraryAlbum', name: album.title, artist: album.album_artist, albumId: album.id }, true)}
            results={localResults().filter((row) => filter() === 'all' || (filter() === 'songs' && row.kind === 'track') || (filter() === 'artists' && row.kind === 'artist'))}
            playlists={filter() === 'all' || filter() === 'playlists' ? matchingPlaylists() : []}
            onPlaylist={(name) => push({ kind: 'playlist', name }, true)}
            query={query()}
            onArtist={(name) => push({ kind: 'libraryArtist', name, artistId: libraryArtists().find((row) => row.name === name)?.id }, true)}
            renderTrack={renderTrack}
            onSearchGlobal={() => {
              const value = query();
              setScope('global');
              runSearch(value);
            }}
            onUse={inAuto() ? (tracks) => actions.addAutoSource(tracks, query()) : undefined}
          />
        </Match>
        <Match when={globalSearching()}>
          <GlobalSearchView
            sections={panelSections()}
            playlists={scope() !== 'youtube' && (filter() === 'all' || filter() === 'playlists') ? matchingPlaylists() : []}
            onPlaylist={(name) => push({ kind: 'playlist', name }, true)}
            top={topResult()}
            youtube={filter() === 'all' || filter() === 'songs' ? ytResults() : []}
            direct={direct()}
            loading={loading() || ytLoading()}
            failed={failed()}
            resolving={resolving()}
            onRetry={() => runSearch(query())}
            primaryLabel={inAuto() ? t(referenceMode() ? 'musicExplorer.reference' : 'musicExplorer.request') : undefined}
            autoRow={autoRow}
            onTrack={(item) => void useItem(item, inAuto() ? placeTrack : actions.playNow)}
            onQueue={(item) => void useItem(item, actions.enqueue)}
            onEntity={(item) => {
              if (item.type === 'playlist') { push({ kind: 'playlist', name: item.title }, true); } else if (item.type === 'artist') {
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
            onYoutube={(result) => inAuto() ? placeTrack(resultTrack(result)) : actions.playNow(resultTrack(result))}
          />
        </Match>
        <Match when={true}>
          <Switch>
            <Match when={currentView().kind === 'root'}>
              <RootView autoRow={autoRow} />
            </Match>
            <Match when={currentView().kind === 'library'}>
              <LibraryView
                tracks={libraryTracks()}
                artists={libraryArtists()}
                onBack={back}
                onSearch={activateLibrarySearch}
                onArtist={(name) => push({ kind: 'libraryArtist', name, artistId: libraryArtists().find((row) => row.name === name)?.id })}
                onAlbum={(album) => push({ kind: 'libraryAlbum', name: album.title, artist: album.album_artist, albumId: album.id })}
                renderTrack={renderTrack}
                onUse={inAuto() ? (tracks) => actions.addAutoSource(tracks, t('nav.library')) : undefined}
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
                onUse={inAuto() ? (tracks) => actions.addAutoSource(tracks, t('nav.favourites')) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'libraryArtist'}>
              <LibraryArtistView
                name={(currentView() as Extract<BrowserView, { kind: 'libraryArtist' }>).name}
                onAlbum={(album) => push({ kind: 'libraryAlbum', name: album.title, artist: album.album_artist, albumId: album.id })}
                artistId={(currentView() as Extract<BrowserView, { kind: 'libraryArtist' }>).artistId}
                onExplore={() => push({ kind: 'catalogArtist', name: (currentView() as { name: string }).name })}
                onBack={back}
                renderTrack={renderTrack}
                onUse={inAuto() ? (tracks) => actions.addAutoSource(tracks, (currentView() as Extract<BrowserView, { kind: 'libraryArtist' }>).name) : undefined}
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
                onUse={inAuto() ? (tracks) => actions.addAutoSource(tracks, (currentView() as Extract<BrowserView, { kind: 'playlist' }>).name) : undefined}
              />
            </Match>
            <Match when={currentView().kind === 'libraryAlbum'}>
              <LibraryAlbumView view={currentView() as Extract<BrowserView, { kind: 'libraryAlbum' }>} onBack={back} renderTrack={renderTrack} inAuto={inAuto()} />
            </Match>
            <Match when={currentView().kind === 'catalogArtist'}>
              <CatalogArtistView
                view={currentView() as Extract<BrowserView, { kind: 'catalogArtist' }>}
                onBack={back}
                onArtist={(name, deezerId) => push({ kind: 'catalogArtist', name, deezerId })}
                onAlbum={(name, artist, deezerId) => push({ kind: 'catalogAlbum', name, artist, deezerId })}
                inAuto={inAuto()}
                routeMode={inAuto()}
                autoRow={autoRow}
                onRouteItem={(item) => void useItem(item, placeTrack)}
              />
            </Match>
            <Match when={currentView().kind === 'catalogAlbum'}>
              <CatalogAlbumView
                view={currentView() as Extract<BrowserView, { kind: 'catalogAlbum' }>}
                onBack={back}
                inAuto={inAuto()}
                routeMode={inAuto()}
                autoRow={autoRow}
                onRouteItem={(item) => void useItem(item, placeTrack)}
              />
            </Match>
          </Switch>
        </Match>
      </Switch></ErrorBoundary>
    </aside></CollectionPlacementContext.Provider>
  );
}

function RootView(props: { autoRow: (track: Track) => AutoRowProps }) {
  return (
    <div class={styles.body} data-browser-body>
      <section class={styles.section}>
        <div class={styles.sectionHead}>
          <h2>{t('discoverNodes.title')}</h2>
          <button type="button" aria-label={t('discoverNodes.refresh')} disabled={nodeLoading()} onClick={refreshNodeFeed}>
            <RefreshIcon spinning={nodeLoading()} />
          </button>
        </div>
        <Show when={!nodeLoading() || nodeFeed().length > 0} fallback={<SkeletonRows count={6} />}>
          <For each={nodeFeed()}>
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
                  {...props.autoRow(track)}
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
  artists: ReturnType<typeof catalogArtists>;
  onBack: () => void;
  onSearch: () => void;
  onArtist: (name: string) => void;
  onAlbum: (album: CatalogAlbum) => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onUse?: (tracks: Track[]) => void;
}) {
  const [albums] = createResource(() => { void state.catalog.revision; return libraryTab() === 'albums' ? albumBrowseQuery(albumSort(), albumFilter()) : false; }, (params) => api.getLibraryAlbums(params));
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
    <div class={styles.body} data-browser-body ref={setScrollRef}>
      <ViewHeader title={t('nav.library')}>
        <Show when={props.onUse}><button type="button" onClick={() => props.onUse?.(props.tracks)}>{t('musicExplorer.reference')}</button></Show>
        <button type="button" aria-label={t('nowPlayingBrowser.searchLibrary')} onClick={props.onSearch}><SearchIcon /></button>
      </ViewHeader>
      <div class={styles.tabs}>
        <button classList={{ [styles.activeTab]: libraryTab() === 'songs' }} type="button" onClick={() => setLibraryTab('songs')}>{t('library.songs')}</button>
        <button classList={{ [styles.activeTab]: libraryTab() === 'albums' }} type="button" onClick={() => setLibraryTab('albums')}>{t('library.albums')}</button>
        <button classList={{ [styles.activeTab]: libraryTab() === 'artists' }} type="button" onClick={() => setLibraryTab('artists')}>{t('library.artists')}</button>
        <Show when={libraryTab() === 'albums'}><button type="button" onClick={openAlbumBrowseMenu} aria-label={t('library.albumSortTitle')}><SortIcon /></button></Show>
        <Show when={libraryTab() === 'songs'}>
          <button class={styles.sort} type="button" aria-label={t('library.sortTitle')} onClick={sort}><SortIcon /></button>
        </Show>
      </div>
      <Show when={libraryTab() === 'songs'}><select class={styles.libraryFilter} aria-label={t('musicExplorer.filter')} value={libraryFilter()} onChange={(event) => setLibraryFilter(event.currentTarget.value)}><option value="all">{t('musicExplorer.all')}</option><option value="downloaded">{t('musicExplorer.downloaded')}</option></select></Show>
      <Show when={libraryTab() === 'albums'}><Show when={!albums.loading} fallback={<SkeletonRows count={6} />}><For each={collateAlbums(albums() ?? [], albumSort())}>{(album) => <NavigationRow title={album.title} subtitle={album.album_artist} cover={album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined} onClick={() => props.onAlbum(album)} />}</For></Show></Show>
      <Show when={libraryTab() !== 'albums'}><Show
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
                  cover={coverUrl(row.coverId, 'thumb')}
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
      </Show></Show>
    </div>
  );
}

function LibraryArtistView(props: {
  name: string;
  artistId?: string;
  onAlbum: (album: CatalogAlbum) => void;
  onExplore: () => void;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onUse?: (tracks: Track[]) => void;
}) {
  const [catalog] = createResource(() => props.artistId, (id) => api.getLibraryArtist(id));
  const tracks = createMemo(() => props.artistId ? tracksByIds(catalog()?.track_ids ?? []) :
    musicLibrary().filter((track) =>
      artistKey(track.artist) === artistKey(props.name) || artistKey(track.album_artist) === artistKey(props.name),
    ),
  );
  const [scrollRef, setScrollRef] = createSignal<HTMLElement | null>(null);
  return (
    <div class={styles.body} data-browser-body ref={setScrollRef}>
      <ViewHeader title={props.name} meta={`${tracks().length}`} onBack={props.onBack}>
        <button type="button" onClick={props.onExplore}>{t('musicExplorer.catalog')}</button>
        <Show when={props.onUse}><CollectionActions title={props.name} tracks={tracks()} auto onReference={props.onUse} /></Show>
      </ViewHeader>
      <For each={catalog()?.albums ?? []}>{(album) => <NavigationRow title={album.title} subtitle={album.album_artist} cover={album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined} onClick={() => props.onAlbum(album)} />}</For>
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

function LibraryAlbumView(props: {
  view: Extract<BrowserView, { kind: 'libraryAlbum' }>;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  inAuto: boolean;
}) {
  const [album] = createResource(() => props.view.albumId, (id) => api.getLibraryAlbum(id));
  const tracks = createMemo(() => tracksByIds(album()?.track_ids ?? []));
  return <Show when={!album.loading} fallback={<SkeletonRows count={8} />}>
    <TrackCollectionView title={props.view.name} tracks={tracks()} empty={t('album.noCatalogData')}
      context={{ id: `album:${props.view.albumId}`, kind: 'album', label: props.view.name }} onBack={props.onBack}
      renderTrack={props.renderTrack} showPlayAll={!props.inAuto} onUse={props.inAuto ? (rows) => actions.addAutoSource(rows, props.view.name) : undefined} />
  </Show>;
}

function LocalSearchView(props: {
  albums: CatalogAlbum[];
  onAlbum: (album: CatalogAlbum) => void;
  playlists: string[];
  onPlaylist: (name: string) => void;
  results: LibrarySearchResult[];
  query: string;
  onArtist: (name: string) => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  onSearchGlobal: () => void;
  onUse?: (tracks: Track[]) => void;
}) {
  const tracks = createMemo(() => props.results.flatMap((result) => result.kind === 'track' ? [result.track] : []));
  return (
    <div class={styles.body} data-browser-body>
      <ViewHeader title={t('nowPlayingBrowser.libraryResults')} meta={`${props.results.length}`}>
        <Show when={props.onUse}><button type="button" disabled={!tracks().length} onClick={() => props.onUse?.(tracks())}>{t('musicExplorer.reference')}</button></Show>
      </ViewHeader>
      <For each={props.albums}>{(album) => <NavigationRow title={album.title} subtitle={album.album_artist} onClick={() => props.onAlbum(album)} />}</For>
      <For each={props.playlists}>{(name) => <NavigationRow title={name} subtitle={t('nav.playlists')} onClick={() => props.onPlaylist(name)} />}</For>
      <For each={props.results}>
        {(result) => result.kind === 'artist'
          ? <NavigationRow title={result.artist.name} subtitle={t('library.artistTrackCount', { count: result.artist.count })} cover={coverUrl(result.artist.coverId, 'thumb')} round onClick={() => props.onArtist(result.artist.name)} />
          : props.renderTrack(result.track, () => actions.playFrom(
              tracks(),
              Math.max(0, tracks().findIndex((track) => track.id === result.track.id)),
              { context: { id: 'library-search', kind: 'search', label: t('library.searchLibrary') } },
            ))}
      </For>
      <div class={styles.searchEverywhere}>
        <Show when={props.results.length === 0 && !props.albums.length && !props.playlists.length}>
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
  const [editing, setEditing] = createSignal(false);
  const createNew = async () => { const name = await createPlaylistDialog(); if (name) props.onOpen(name); };

  return (
    <div class={styles.body} data-browser-body>
      <ViewHeader title={t('nav.playlists')} meta={`${props.names.length}`}>
        <button type="button" onClick={() => void createNew()}>{t('musicExplorer.newPlaylist')}</button>
        <button type="button" onClick={() => setEditing(!editing())}>{t(editing() ? 'musicExplorer.done' : 'musicExplorer.edit')}</button>
      </ViewHeader>
      <Show when={editing()} fallback={
      <For each={props.names}>
        {(name) => {
          const ids = () => state.playlists[name] ?? [];
          const cover = () => {
            const track = pickPlaylistCoverTrack(name, ids(), props.byId, state.librarySettings);
            return track ? trackCoverUrl(track, 'thumb') : undefined;
          };
          return <NavigationRow title={name} subtitle={`${ids().length}`} cover={cover()} onMenu={(event) => openPlaylistMenu(name, {}, event)} onClick={() => props.onOpen(name)} />;
        }}
      </For>}>
        <MusicReorderList items={props.names} label={(name) => name} render={(name) => <span>{name}</span>} onChange={actions.reorderPlaylists} />
      </Show>
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
  const placement = useContext(CollectionPlacementContext);
  const tracks = createMemo(() =>
    (state.playlists[props.name] ?? []).map((id) => props.byId.get(id)).filter((track): track is Track => !!track),
  );
  const [editing, setEditing] = createSignal(false);
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
      headerActions={<>
        <Show when={editing()}><button type="button" onClick={() => setEditing(false)}>{t('musicExplorer.done')}</button></Show>
        <button type="button" aria-label={t('playlistDetail.ariaOptions')} onClick={(event) => openPlaylistMenu(props.name, { beforeQueueId: placement.beforeQueueId, onPlaced: placement.onCompleted, onEdit: () => setEditing(true), onRenamed: (name) => navigation.renamePlaylist(props.name, name), onDeleted: () => { navigation.back(); } }, event)}>•••</button>
      </>}
      editContent={editing() ? <MusicReorderList items={state.playlists[props.name] ?? []} label={(id) => props.byId.get(id)?.title ?? id} render={(id) => <span>{props.byId.get(id)?.title ?? id}</span>} onChange={(ids) => actions.reorderPlaylistTracks(props.name, ids)} /> : undefined}
    />
  );
}

function TrackCollectionView(props: {
  headerActions?: JSX.Element;
  editContent?: JSX.Element;
  title: string;
  tracks: Track[];
  empty: string;
  context: PlaybackContextDescriptor;
  onBack: () => void;
  renderTrack: (track: Track, onPlay: () => void) => JSX.Element;
  showPlayAll: boolean;
  onUse?: (tracks: Track[]) => void;
}) {
  const [scroller, setScroller] = createSignal<HTMLElement | null>(null);
  return (
    <div class={styles.body} data-browser-body ref={setScroller}>
      <ViewHeader title={props.title} meta={`${props.tracks.length}`} onBack={props.onBack}>
        <Show when={props.onUse}><CollectionActions title={props.title} tracks={props.tracks} auto hideReferenceMenu={Boolean(props.headerActions)} onReference={props.onUse} /></Show>
        <Show when={!props.onUse && props.showPlayAll}>
          <button type="button" disabled={props.tracks.length === 0} aria-label={t('playlistDetail.play')} onClick={() =>
            actions.playFrom(props.tracks, 0, { context: props.context })
          }><PlayIcon /></button>
        </Show>
        {props.headerActions}
      </ViewHeader>
      <Show when={props.editContent} fallback={
        <Show when={props.tracks.length > 0} fallback={<div class={styles.empty}><p>{props.empty}</p></div>}>
          <VirtualRows items={props.tracks} scrollElement={scroller} rowHeight={{ cssVar: '--row-h', fallback: 56 }}>{(track, index) => {
            const row = track(); return row ? props.renderTrack(row, () => actions.playFrom(props.tracks, index, { context: props.context })) : null;
          }}</VirtualRows>
        </Show>
      }>{props.editContent}</Show>
    </div>
  );
}

function GlobalSearchView(props: {
  playlists: string[];
  onPlaylist: (name: string) => void;
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
  autoRow: (target: Track | CatalogItem) => AutoRowProps;
}) {
  const empty = () => !props.top && props.playlists.length === 0 && props.sections.every((section) => section.items.length === 0);
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
        cover={item.cover || (item.track_id ? coverUrl(item.track_id, 'thumb') : undefined)}
        seed={item.id}
        active={isPlayingItem(item)}
        queued={isQueuedItem(item)}
        resolving={props.resolving.has(item.id)}
        owned={item.type === 'library_track' || !!ownedTrackForItem(item)}
        primaryLabel={props.primaryLabel}
        onPlay={() => props.onTrack(item)}
        onQueue={() => props.onQueue(item)}
        {...props.autoRow(item)}
      />
    );

  return (
    <div class={styles.body} data-browser-body aria-busy={props.loading}>
      <Show when={props.loading && empty() && props.youtube.length === 0 && !props.direct}>
        <SkeletonRows count={8} />
      </Show>
      <Show when={props.top}>{(item) => row(item())}</Show>
      <For each={props.sections}>{(section) => <section class={styles.section}><h2>{section.id === 'playlists' ? t('nav.playlists') : t(`library.${section.id}`)}</h2><For each={section.items}>{(item) => row(item)}</For></section>}</For>
      <Show when={props.playlists.length}><section class={styles.section}><h2>{t('nav.playlists')}</h2><For each={props.playlists}>{(name) => <NavigationRow title={name} subtitle={`${state.playlists[name]?.length ?? 0}`} onClick={() => props.onPlaylist(name)} />}</For></section></Show>
      <Show when={props.direct}>
        {(result) => <YoutubeRow result={result()} onPlay={() => props.onYoutube(result())} primaryLabel={props.primaryLabel} autoRow={props.autoRow} />}
      </Show>
      <For each={props.youtube}>
        {(result) => <YoutubeRow result={result} onPlay={() => props.onYoutube(result)} primaryLabel={props.primaryLabel} autoRow={props.autoRow} />}
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
  autoRow: (target: Track | CatalogItem) => AutoRowProps;
}) {
  const track = () => resultTrack(props.result);
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
      onPlay={props.onPlay}
      onQueue={() => actions.enqueue(track())}
      onMenu={(event) => openTrackMenu(track(), {}, event)}
      {...props.autoRow(track())}
    />
  );
}

function CatalogArtistView(props: {
  view: Extract<BrowserView, { kind: 'catalogArtist' }>;
  onBack: () => void;
  onAlbum: (name: string, artist: string, deezerId?: string) => void;
  onArtist: (name: string, deezerId?: string) => void;
  inAuto?: boolean;
  routeMode?: boolean;
  autoRow: (target: Track | CatalogItem) => AutoRowProps;
  onRouteItem: (item: CatalogItem) => void;
}) {
  const [profile] = createResource(
    () => [props.view.name, props.view.deezerId] as const,
    ([name, id]) => api.getArtistProfile(name, id),
  );
  const play = (item: CatalogItem, queue: CatalogItem[]) =>
    void playCatalogItem(item, queue, { id: `artist:${props.view.name}`, kind: 'artist', label: props.view.name });
  return (
    <div class={styles.body} data-browser-body>
      <ViewHeader title={props.view.name} onBack={props.onBack}>
        <CollectionActions title={props.view.name} items={profile()?.top_tracks ?? []} auto={Boolean(props.inAuto)} onPlay={() => { const tracks = profile()?.top_tracks ?? []; if (tracks[0]) play(tracks[0], tracks); }} />
      </ViewHeader>
      <Show when={!profile.loading} fallback={<SkeletonRows count={8} />}>
        <Show when={profile()} fallback={<div class={styles.empty}>{t('artist.noCatalogData')}</div>}>
          {(data) => (
            <>
              <Show when={!data().resolved && data().candidates?.length}><For each={data().candidates}>{(candidate) => <NavigationRow title={candidate.name} subtitle={`${candidate.nb_album ?? 0} ${t('library.albums')}`} cover={candidate.picture} onClick={() => props.onArtist(candidate.name, candidate.deezer_id)} />}</For></Show>
              <section class={styles.section}>
                <h2>{t('artist.topTracks')}</h2>
                <For each={data().top_tracks}>
                  {(item) => (
                    <BrowserTrackRow
                      title={item.title}
                      subtitle={itemArtist(item)}
                      cover={item.cover}
                      seed={item.id}
                      active={isPlayingItem(item)}
                      queued={isQueuedItem(item)}
                      onPlay={() => props.routeMode ? props.onRouteItem(item) : play(item, data().top_tracks)}
                      onQueue={() => void enqueueCatalogItem(item)}
                      {...props.autoRow(item)}
                    />
                  )}
                </For>
              </section>
              <section class={styles.section}>
                <h2>{t('artist.albums')}</h2>
                <For each={[...data().albums, ...(data().singles_eps ?? [])]}>{(album) => <NavigationRow title={album.title} subtitle={`${album.year ?? ''}`} cover={album.cover} onClick={() => props.onAlbum(album.title, props.view.name, album.deezer_id)} />}</For>
              </section>
              <section class={styles.section}><h2>{t('artist.related')}</h2><For each={data().related_artists ?? []}>{(artist) => <NavigationRow title={artist.name} subtitle={t('searchPanel.chipArtist')} cover={artist.picture} round onClick={() => props.onArtist(artist.name, artist.deezer_id)} />}</For></section>
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
  inAuto?: boolean;
  routeMode?: boolean;
  autoRow: (target: Track | CatalogItem) => AutoRowProps;
  onRouteItem: (item: CatalogItem) => void;
}) {
  const [profile] = createResource(
    () => [props.view.name, props.view.artist, props.view.deezerId] as const,
    ([name, artist, id]) => api.getAlbumProfile(name, artist, id),
  );
  const play = (item: CatalogItem, queue: CatalogItem[]) =>
    void playCatalogItem(item, queue, { id: `album:${props.view.name}`, kind: 'album', label: props.view.name });
  return (
    <div class={styles.body} data-browser-body>
      <ViewHeader title={props.view.name} meta={props.view.artist} onBack={props.onBack}>
        <CollectionActions title={props.view.name} items={profile()?.tracklist ?? []} auto={Boolean(props.inAuto)} onPlay={() => { const tracks = profile()?.tracklist ?? []; if (tracks[0]) play(tracks[0], tracks); }} />
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
                  onPlay={() => props.routeMode ? props.onRouteItem(item) : play(item, data().tracklist)}
                  onQueue={() => void enqueueCatalogItem(item)}
                  {...props.autoRow(item)}
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
  return <SharedViewHeader {...props} compact />;
}

function NavigationRow(props: { title: string; subtitle: string; cover?: string; round?: boolean; onClick: () => void; onMenu?: (event?: MouseEvent) => void }) {
  const tap = createResponsiveTap({ onTap: props.onClick });
  return (
    <Show when={!mobileListLayout()} fallback={<MusicListRow title={props.title} subtitle={props.subtitle} seed={props.title}
      cover={props.cover} round={props.round} onActivate={props.onClick} onMenu={props.onMenu} />}>
    <button class={styles.navRow} type="button" data-pressable {...tap}>
      <span classList={{ [styles.round]: props.round }} style={coverStyle(props.title, props.cover)} />
      <span><strong>{props.title}</strong><small>{props.subtitle}</small></span>
      <ChevronIcon />
    </button>
    </Show>
  );
}

/**
 * One song, in either of the panel's two lives.
 *
 * `browse` is the ordinary library row. `auto` is the same song inside a DJ
 * session, where a queue and an overflow menu full of *Play next* / *Add to
 * queue* / *Start radio* are answers to questions nobody is asking: there is no
 * manual queue in Auto Mode, only the route. It gets exactly one control, and
 * every list in the panel gets it — that is the whole point of the variant
 * living here rather than at each call site.
 */
function BrowserTrackRow(props: {
  title: string;
  subtitle: string;
  cover?: string;
  seed: string;
  entry?: SavedEntry;
  favouritesKnown?: boolean;
  active: boolean;
  queued: boolean;
  resolving?: boolean;
  owned?: boolean;
  onPlay: () => void;
  onQueue: () => void;
  onMenu?: (event?: MouseEvent) => void;
  primaryLabel?: string;
  variant?: 'browse' | 'auto';
  onAddToRoute?: () => void;
  track?: Track;
  onCarryTrack?: (track: Track) => void;
}) {
  const auto = () => props.variant === 'auto';
  const track = () => props.track ?? { id: props.seed, title: props.title, artist: props.subtitle, cover: props.cover, source: 'preview' as const };
  return <SongRow track={track()} cover={props.cover} active={props.active} compact busy={props.resolving}
    actionLabel={auto() ? `${props.primaryLabel ?? t('musicExplorer.request')}: ${props.title}` : undefined}
    onPlay={() => auto() ? props.onAddToRoute?.() : props.onPlay()}
    primaryAction={auto() && props.onAddToRoute ? { label: props.primaryLabel ?? t('musicExplorer.request'), onSelect: props.onAddToRoute } : undefined}
    onMenu={props.onMenu ? (_track, event) => props.onMenu?.(event) : undefined}
    onDragStart={props.track ? (event) => writeAutoTrackTransfer(event, { track: props.track! }) : undefined}
  />;
}

const icon = (path: JSX.Element) => <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
const SearchIcon = () => icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>);
const BackIcon = () => icon(<path d="m15 18-6-6 6-6" />);
const CloseIcon = () => icon(<path d="m7 7 10 10M17 7 7 17" />);
const ChevronIcon = () => icon(<path d="m9 18 6-6-6-6" />);
const SortIcon = () => icon(<path d="M4 7h16M7 12h10M10 17h4" />);
const PlayIcon = () => icon(<path d="m8 5 11 7-11 7z" />);
/** "A list, plus one." Serves both the queue outside Auto Mode and the route
 * inside it — the two never share a row, and they are the same idea. */
const RefreshIcon = (props: { spinning: boolean }) => <span classList={{ [styles.spinning]: props.spinning }}>{icon(<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />)}</span>;
