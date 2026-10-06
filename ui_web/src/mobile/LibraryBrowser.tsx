import { createMemo, createResource, createSignal, createEffect, on, For, Show, onCleanup } from 'solid-js';
import { registerNativeBack } from './backNavigation';
import { request } from '../lib/http';
import { coverUrl, registerArtworkMetadata } from '../lib/media';
import { VirtualBrowseRows } from '../components/VirtualBrowseRows';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import { t } from '../lib/i18n';
import { playlistNames } from '../lib/playlistOrder';
import { albumBookmark, artistBookmark } from './entityMarks';
import type { ProgramContext } from '../lib/program/runtime';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import { trackCount } from '../lib/format';
import type { CatalogAlbum, CatalogArtist, LibrarySettings, PlaylistMap, Track } from '../types/music';
import { availableLibrary, type OfflineState } from './offline';
import { openContextMenu } from '../lib/contextMenu';
import { api } from '../lib/api';
import { albumFilter, albumSort, filterTracks, libraryFilter, librarySort, setAlbumFilter, setAlbumSort, setLibraryFilter, setLibrarySort, sortTracks } from '../lib/libraryView';
import { ALBUM_SORTS, NO_ALBUM_FILTER, albumBrowseQuery, collateAlbums } from '../lib/albumBrowse';
import type { MenuAction } from '../components/ActionMenu';
import styles from './AndroidStart.module.css';

export interface BrowseSnapshot { podcast_subscriptions?: import('../types/podcast').PodcastSubscription[]; podcast_tracks?: Track[]; tracks: Track[]; playlists?: PlaylistMap; settings?: LibrarySettings }
/** Account browse surface; writes are delegated, sharing rows/artwork without the web player. */
export default function LibraryBrowser(props: { initialTab?: 'songs' | 'playlists'; snapshot: BrowseSnapshot; revision: number; isFavourite?: (track: Track) => boolean; onPlay?: (tracks: Track[], selectedIndex: number, context?: ProgramContext) => void; activeId?: string; isActive?: (track: Track) => boolean; onMenu?: (track: Track, event?: MouseEvent, context?: { playlist: string; index: number }) => void; onPlaylistMenu?: (name: string, event?: MouseEvent) => void; onCreatePlaylist?: () => void; offline?: OfflineState | null; disconnected?: boolean; onManageOffline?: () => void; onEntityMenu?: (entry: SavedEntity, event?: MouseEvent) => void; onCollectionMenu?: (tracks: Track[], title: string, event?: MouseEvent, context?: { kind: 'albums' | 'artists' | 'playlists'; id: string; bookmark?: SavedEntity }) => void }) {
  const [tab, setTab] = createSignal<'songs' | 'albums' | 'artists' | 'playlists' | 'favourites'>(props.initialTab ?? 'songs');
  const [collection, setCollection] = createSignal<{ title: string; ids: string[]; kind: 'albums' | 'artists' | 'playlists'; id: string; bookmark?: SavedEntity } | null>(null);
  const [onlyAvailable, setOnlyAvailable] = createSignal(false);
  const library = createMemo<BrowseSnapshot>(() => (props.disconnected || onlyAvailable()) && props.offline ? availableLibrary(props.offline) : props.snapshot);
  const localCollections = (kind: 'albums' | 'artists') => {
    const groups = new Map<string, { id: string; title: string; ids: string[]; artist: string }>();
    for (const track of library().tracks) {
      const title = kind === 'albums' ? track.album || t('libraryView.noAlbum') : track.artist;
      const id = (kind === 'albums' ? track.album_id : track.artist_id) || `${kind}:${kind === 'albums' ? track.album_artist || track.artist : ''}:${title}`;
      const group = groups.get(id) ?? { id, title, ids: [], artist: track.album_artist || track.artist };
      group.ids.push(track.id); groups.set(id, group);
    }
    return [...groups.values()];
  };
  const [query, setQuery] = createSignal('');
  const [detailError, setDetailError] = createSignal(false);
  const [albums, { refetch: retryAlbums }] = createResource(() => tab() === 'albums' ? `${props.revision}:${props.disconnected}:${onlyAvailable()}:${albumSort()}:${JSON.stringify(albumFilter())}:${props.offline?.items.filter(item => item.state === 'ready').map(item => item.track.id).join(',')}` : false,
    (): Promise<{ albums: CatalogAlbum[] }> => props.disconnected || onlyAvailable()
      ? Promise.resolve({ albums: collateAlbums(localCollections('albums').map(group => ({ id: group.id, title: group.title, album_artist: group.artist, track_count: group.ids.length, duration: 0, is_compilation: false })), albumSort()) })
      // Ordering and genre/year filtering are the engine's job, as on the web; only the alphabet is collated here.
      : api.getLibraryAlbums(albumBrowseQuery(albumSort(), albumFilter())).then(albums => ({ albums: collateAlbums(albums, albumSort()) })));
  const [artists, { refetch: retryArtists }] = createResource(() => tab() === 'artists' ? `${props.revision}:${props.disconnected}:${onlyAvailable()}:${props.offline?.items.filter(item => item.state === 'ready').map(item => item.track.id).join(',')}` : false,
    (): Promise<{ artists: CatalogArtist[] }> => props.disconnected || onlyAvailable() ? Promise.resolve({ artists: localCollections('artists').map(group => ({ id: group.id, name: group.title, track_count: group.ids.length, album_count: 0 })) }) : request<{ artists: CatalogArtist[] }>('/api/library/artists'));
  const collectionTracks = createMemo(() => {
    registerArtworkMetadata(library().tracks);
    const ids = collection()?.ids;
    const byId = new Map(library().tracks.map(track => [track.id, track]));
    const rows = ids ? ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : library().tracks;
    return rows;
  });
  const tracks = createMemo(() => {
    let rows = tab() === 'favourites' ? collectionTracks().filter(track => props.isFavourite?.(track)) : collectionTracks();
    // A collection keeps its own order; the songs list follows the shared library preferences.
    if (!collection() && tab() === 'songs') rows = sortTracks(filterTracks(rows, libraryFilter()), librarySort(),
      new Set(librarySort() === 'fav' ? rows.filter(track => props.isFavourite?.(track)).map(track => track.id) : []));
    const filter = query().trim().toLocaleLowerCase();
    return filter ? rows.filter(track => `${track.title} ${track.artist} ${track.album ?? ''}`.toLocaleLowerCase().includes(filter)) : rows;
  });
  let detailEpoch = 0;
  let detailController: AbortController | undefined;
  const cancelDetail = () => { detailEpoch++; detailController?.abort(); detailController = undefined; };
  onCleanup(cancelDetail);
  async function open(kind: 'albums' | 'artists', id: string, title: string, bookmark?: SavedEntity) {
    cancelDetail(); const epoch = detailEpoch;
    const controller = new AbortController(); detailController = controller;
    setDetailError(false);
    try {
      const detail = props.disconnected || onlyAvailable() ? { track_ids: localCollections(kind).find(group => group.id === id)?.ids ?? [] } : await request<{ track_ids?: string[] }>(`/api/library/${kind}/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (epoch === detailEpoch) { setCollection({ title, ids: detail.track_ids ?? [], kind, id, bookmark }); setQuery(''); }
    } catch { if (epoch === detailEpoch) setDetailError(true); }
  }
  createEffect(on(() => props.revision, () => {
    const current = collection();
    if (!current) return;
    if (current.kind === 'playlists') {
      const ids = library().playlists?.[current.id];
      setCollection(ids ? { ...current, ids } : null);
      return;
    }
    if (props.disconnected || onlyAvailable()) { setCollection({ ...current, ids: localCollections(current.kind).find(group => group.id === current.id)?.ids ?? [] }); return; }
    cancelDetail(); const epoch = detailEpoch;
    const controller = new AbortController(); detailController = controller;
    void request<{ track_ids?: string[] }>(`/api/library/${current.kind}/${encodeURIComponent(current.id)}`, { signal: controller.signal })
      .then(detail => { if (epoch === detailEpoch) { setCollection({ ...current, ids: detail.track_ids ?? [] }); setDetailError(false); } })
      .catch(() => { if (epoch === detailEpoch) setDetailError(true); });
  }, { defer: true }));
  const selectTab = (next: typeof tab extends () => infer T ? T : never) => {
    cancelDetail(); setCollection(null); setQuery(''); setDetailError(false); setTab(next);
  };
  const closeCollection = () => { cancelDetail(); setCollection(null); setDetailError(false); };
  registerNativeBack(() => {
    if (collection()) { closeCollection(); return true; }
    if (query()) { setQuery(''); return true; }
    if (tab() !== 'songs') { selectTab('songs'); return true; }
    return false;
  });
  const songSorts = (): MenuAction[] => ([['recent', 'library.sortRecent'], ['az', 'library.sortAZ'], ['fav', 'library.sortFavFirst']] as const).map(([value, label]) =>
    ({ label: t(label), selected: librarySort() === value, onSelect: () => setLibrarySort(value) }));
  const downloadedFilter = (): MenuAction =>
    ({ label: t('library.filterDownloaded'), selected: libraryFilter() === 'downloaded', onSelect: () => setLibraryFilter(libraryFilter() === 'downloaded' ? 'all' : 'downloaded') });
  /** Album order and the genre/year filter: the engine's lists, read when the menu opens. */
  async function albumMenu(event?: MouseEvent) {
    const active = albumFilter();
    const filters: MenuAction[] = [{ label: t('library.albumFilterAll'), selected: active.kind === 'none', onSelect: () => setAlbumFilter(NO_ALBUM_FILTER) }];
    if (!props.disconnected && !onlyAvailable()) {
      const [genres, years] = await Promise.all([api.getLibraryGenres().catch(() => []), api.getLibraryYears().catch(() => [])]);
      if (genres.length) filters.push({ label: t('library.albumFilterByGenre'), onSelect: () => openContextMenu({ title: t('library.albumFilterByGenre'),
        actions: genres.map(genre => ({ label: genre.name, selected: active.kind === 'genre' && active.value === genre.name, onSelect: () => setAlbumFilter({ kind: 'genre', value: genre.name }) })) }) });
      if (years.length) filters.push({ label: t('library.albumFilterByYear'), onSelect: () => openContextMenu({ title: t('library.albumFilterByYear'),
        actions: years.map(year => ({ label: String(year.year), selected: active.kind === 'year' && active.value === year.year, onSelect: () => setAlbumFilter({ kind: 'year', value: year.year }) })) }) });
    }
    openContextMenu({ title: t('library.albums'), sections: [
      { label: t('library.albumSortTitle'), actions: ALBUM_SORTS.map(sort => ({ label: t(`library.albumSort.${sort}`), selected: albumSort() === sort, onSelect: () => setAlbumSort(sort) })) },
      { label: t('library.albumFilterTitle'), actions: filters },
    ] }, event);
  }
  return <section class={styles.library} data-testid="android-library">
    <p class={styles.notice}>{t('android.browseOnly')}</p>
    <nav aria-label={t('library.title')} class={styles.tabs}>
      <For each={[...(['songs', 'albums', 'artists', 'playlists'] as const), ...(props.isFavourite ? ['favourites' as const] : [])]}>{item =>
        <button type="button" aria-pressed={tab() === item} onClick={() => selectTab(item)}>{item === 'playlists' ? t('playlists.title') : t(`library.${item}`)}</button>
      }</For>
    </nav>
    <Show when={collection()}>{item => <div class={styles.collectionHeading}><button type="button" onClick={closeCollection}>{t('common.back')}</button><h2>{item().title}</h2><Show when={props.onCollectionMenu}><button class={styles.menuTrigger} data-collection-menu aria-label={t('songRow.ariaMore')} onClick={event => props.onCollectionMenu?.(collectionTracks(), item().title, event, { kind: item().kind, id: item().id, bookmark: props.disconnected || onlyAvailable() ? undefined : item().bookmark })}>⋯</button></Show></div>}</Show>
    <Show when={detailError()}><p role="alert">{t('common.loadFailed')}</p></Show>
    <Show when={collection() || tab() === 'songs' || tab() === 'favourites'} fallback={
      <Show when={tab() === 'playlists'} fallback={
        <><Show when={tab() === 'albums'}><div class={styles.libraryTools}><button class={styles.menuTrigger} data-album-menu aria-label={t('library.albumSortTitle')} onClick={event => void albumMenu(event)}>⋯</button></div></Show>
        <Show when={!albums.error && !artists.error} fallback={<p role="alert">{t('common.loadFailed')} <button onClick={() => { void retryAlbums(); void retryArtists(); }}>{t('common.retry')}</button></p>}>
          <Show when={!albums.loading && !artists.loading} fallback={<p role="status">{t('common.loading')}</p>}>
            <Show when={tab() === 'albums'} fallback={<For each={artists()?.artists ?? []} fallback={<EmptyState>{t('library.emptyArtists')}</EmptyState>}>{artist =>
              <MusicListRowView title={artist.name} subtitle={trackCount(artist.track_count)} seed={artist.id}
                round cover={artist.cover_track_id ? coverUrl(artist.cover_track_id, 'thumb') : undefined}
                onMenu={props.onEntityMenu && !props.disconnected && !onlyAvailable() ? event => props.onEntityMenu?.(artistBookmark(artist), event) : undefined}
                onActivate={() => void open('artists', artist.id, artist.name, artistBookmark(artist))} />
            }</For>}>
              <For each={albums()?.albums ?? []} fallback={<EmptyState>{albumFilter().kind === 'none' ? t('library.emptyAlbums') : t('library.emptyAlbumFilter')}<Show when={albumFilter().kind !== 'none'}> <button type="button" onClick={() => setAlbumFilter(NO_ALBUM_FILTER)}>{t('library.albumFilterAll')}</button></Show></EmptyState>}>{album => <MusicListRowView title={album.title}
                subtitle={`${album.album_artist} · ${trackCount(album.track_count)}`} seed={album.id}
                cover={album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined}
                onMenu={props.onEntityMenu && !props.disconnected && !onlyAvailable() ? event => props.onEntityMenu?.(albumBookmark(album), event) : undefined}
                onActivate={() => void open('albums', album.id, album.title, albumBookmark(album))} />}</For>
            </Show>
          </Show>
        </Show></>
      }><For each={playlistNames(library().playlists ?? {}, library().settings?.playlist_order)} fallback={<EmptyState>{t('playlists.empty')}</EmptyState>}>{name =>
          <MusicListRowView title={name} subtitle={trackCount(library().playlists?.[name]?.length ?? 0)} seed={name}
            cover={props.disconnected ? undefined : (() => { const id = library().settings?.playlist_covers?.[name] ?? library().playlists?.[name]?.find(id => library().tracks.some(track => track.id === id && track.source !== 'preview')); return id ? coverUrl(id, 'thumb') : undefined; })()}
            onMenu={props.onPlaylistMenu ? event => props.onPlaylistMenu?.(name, event) : undefined} onActivate={() => { setCollection({ title: name, ids: library().playlists?.[name] ?? [], kind: 'playlists', id: name }); setQuery(''); }} />
      }</For></Show>
    }>
      <div class={styles.libraryTools}><label class={styles.field}>{t('library.searchLibrary')}<input type="search" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label>
      <Show when={props.onManageOffline}><button class={styles.menuTrigger} data-library-menu aria-label={t('songRow.ariaMore')} onClick={event => {
        const offline: MenuAction[] = [
        { label: t(onlyAvailable() ? 'android.offlineAll' : 'android.offlineOnly'), disabled: props.disconnected, selected: onlyAvailable() || props.disconnected, onSelect: () => { detailEpoch++; setCollection(null); setOnlyAvailable(value => !value); } },
        { label: t('android.offlineManage'), onSelect: () => props.onManageOffline?.() },
        ...(tab() === 'playlists' && props.onCreatePlaylist ? [{ label: t('playlistPicker.new'), disabled: props.disconnected, onSelect: () => props.onCreatePlaylist?.() }] : []),
      ];
        // The songs list adds the web's order and filter, grouped as on the web.
        if (!collection() && tab() === 'songs') openContextMenu({ title: t('library.title'), sections: [
          { label: t('library.sortTitle'), actions: songSorts() },
          { label: t('library.filterTitle'), actions: [downloadedFilter(), offline[0]] },
          { label: t('android.offlineManage'), actions: offline.slice(1) },
        ] }, event);
        else openContextMenu({ title: t('library.title'), actions: offline }, event);
      }}>⋯</button></Show></div>
      <Show when={tracks().length} fallback={<EmptyState>{t('library.emptyLibrary')}</EmptyState>}>
<VirtualBrowseRows favourite={props.isFavourite} offline={props.disconnected} onMenu={props.onMenu ? (track, event, index) => {
  const selected = collection();
  const occurrence = selected?.kind === 'playlists' && index !== undefined ? tracks().slice(0, index).filter(row => row.id === track.id).length : -1;
  const positions = selected?.ids.flatMap((id, position) => id === track.id ? [position] : []) ?? [];
  props.onMenu?.(track, event, selected?.kind === 'playlists' && positions[occurrence] !== undefined ? { playlist: selected.id, index: positions[occurrence] } : undefined);
} : undefined} tracks={tracks()} activeId={props.activeId} isActive={props.isActive} onPlay={props.onPlay ? index => props.onPlay?.(tracks(), index, collection() ? { kind: collection()!.kind === 'albums' ? 'album' : collection()!.kind === 'artists' ? 'artist' : 'playlist', id: collection()!.id } : undefined) : undefined} />
      </Show>
    </Show>
  </section>;
}
