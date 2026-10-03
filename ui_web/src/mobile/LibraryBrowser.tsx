import { createMemo, createResource, createSignal, createEffect, on, For, Show, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { coverUrl, registerArtworkMetadata } from '../lib/media';
import { VirtualBrowseRows } from '../components/VirtualBrowseRows';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import { t } from '../lib/i18n';
import { playlistNames } from '../lib/playlistOrder';
import { trackCount } from '../lib/format';
import type { CatalogAlbum, CatalogArtist, LibrarySettings, PlaylistMap, Track } from '../types/music';
import { availableLibrary, type OfflineState } from './offline';
import { openContextMenu } from '../lib/contextMenu';
import styles from './AndroidStart.module.css';

export interface BrowseSnapshot { podcast_subscriptions?: import('../types/podcast').PodcastSubscription[]; podcast_tracks?: Track[]; tracks: Track[]; playlists?: PlaylistMap; settings?: LibrarySettings }
/** Read-only account surface. Shares the existing row/artwork/tokens; imports no player runtime. */
export default function LibraryBrowser(props: { snapshot: BrowseSnapshot; revision: number; isFavourite?: (track: Track) => boolean; onPlay?: (tracks: Track[], selectedIndex: number) => void; activeId?: string; onMenu?: (track: Track, event?: MouseEvent, context?: { playlist: string; index: number }) => void; onPlaylistMenu?: (name: string, event?: MouseEvent) => void; onCreatePlaylist?: () => void; offline?: OfflineState | null; disconnected?: boolean; onManageOffline?: () => void; onCollectionMenu?: (tracks: Track[], title: string, event?: MouseEvent, context?: { kind: 'albums' | 'artists' | 'playlists'; id: string }) => void }) {
  const [tab, setTab] = createSignal<'songs' | 'albums' | 'artists' | 'playlists' | 'favourites'>('songs');
  const [collection, setCollection] = createSignal<{ title: string; ids: string[]; kind: 'albums' | 'artists' | 'playlists'; id: string } | null>(null);
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
  const [albums, { refetch: retryAlbums }] = createResource(() => tab() === 'albums' ? `${props.revision}:${props.disconnected}:${onlyAvailable()}:${props.offline?.items.filter(item => item.state === 'ready').map(item => item.track.id).join(',')}` : false,
    (): Promise<{ albums: CatalogAlbum[] }> => props.disconnected || onlyAvailable() ? Promise.resolve({ albums: localCollections('albums').map(group => ({ id: group.id, title: group.title, album_artist: group.artist, track_count: group.ids.length, duration: 0, is_compilation: false })) }) : request<{ albums: CatalogAlbum[] }>('/api/library/albums'));
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
    const rows = tab() === 'favourites' ? collectionTracks().filter(track => props.isFavourite?.(track)) : collectionTracks();
    const filter = query().trim().toLocaleLowerCase();
    return filter ? rows.filter(track => `${track.title} ${track.artist} ${track.album ?? ''}`.toLocaleLowerCase().includes(filter)) : rows;
  });
  let detailEpoch = 0;
  onCleanup(() => { detailEpoch++; });
  async function open(kind: 'albums' | 'artists', id: string, title: string) {
    const epoch = ++detailEpoch;
    setDetailError(false);
    try {
      const detail = props.disconnected || onlyAvailable() ? { track_ids: localCollections(kind).find(group => group.id === id)?.ids ?? [] } : await request<{ track_ids?: string[] }>(`/api/library/${kind}/${encodeURIComponent(id)}`);
      if (epoch === detailEpoch) { setCollection({ title, ids: detail.track_ids ?? [], kind, id }); setQuery(''); }
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
    const epoch = ++detailEpoch;
    void request<{ track_ids?: string[] }>(`/api/library/${current.kind}/${encodeURIComponent(current.id)}`)
      .then(detail => { if (epoch === detailEpoch) { setCollection({ ...current, ids: detail.track_ids ?? [] }); setDetailError(false); } })
      .catch(() => { if (epoch === detailEpoch) setDetailError(true); });
  }, { defer: true }));
  const selectTab = (next: typeof tab extends () => infer T ? T : never) => {
    detailEpoch++; setCollection(null); setQuery(''); setDetailError(false); setTab(next);
  };
  return <section class={styles.library} data-testid="android-library">
    <p class={styles.notice}>{t('android.browseOnly')}</p>
    <nav aria-label={t('library.title')} class={styles.tabs}>
      <For each={[...(['songs', 'albums', 'artists', 'playlists'] as const), ...(props.isFavourite ? ['favourites' as const] : [])]}>{item =>
        <button type="button" aria-pressed={tab() === item} onClick={() => selectTab(item)}>{item === 'playlists' ? t('playlists.title') : t(`library.${item}`)}</button>
      }</For>
    </nav>
    <Show when={collection()}>{item => <div class={styles.collectionHeading}><button type="button" onClick={() => { detailEpoch++; setCollection(null); }}>{t('common.back')}</button><h2>{item().title}</h2><Show when={props.onCollectionMenu}><button class={styles.menuTrigger} data-collection-menu aria-label={t('songRow.ariaMore')} onClick={event => props.onCollectionMenu?.(collectionTracks(), item().title, event, { kind: item().kind, id: item().id })}>⋯</button></Show></div>}</Show>
    <Show when={detailError()}><p role="alert">{t('common.loadFailed')}</p></Show>
    <Show when={collection() || tab() === 'songs' || tab() === 'favourites'} fallback={
      <Show when={tab() === 'playlists'} fallback={
        <Show when={!albums.error && !artists.error} fallback={<p role="alert">{t('common.loadFailed')} <button onClick={() => { void retryAlbums(); void retryArtists(); }}>{t('common.retry')}</button></p>}>
          <Show when={!albums.loading && !artists.loading} fallback={<p role="status">{t('common.loading')}</p>}>
            <Show when={tab() === 'albums'} fallback={<For each={artists()?.artists ?? []} fallback={<EmptyState>{t('library.emptyArtists')}</EmptyState>}>{artist =>
              <MusicListRowView title={artist.name} subtitle={trackCount(artist.track_count)} seed={artist.id}
                round cover={artist.cover_track_id ? coverUrl(artist.cover_track_id, 'thumb') : undefined}
                onActivate={() => void open('artists', artist.id, artist.name)} />
            }</For>}>
              <For each={albums()?.albums ?? []} fallback={<EmptyState>{t('library.emptyAlbums')}</EmptyState>}>{album => <MusicListRowView title={album.title}
                subtitle={`${album.album_artist} · ${trackCount(album.track_count)}`} seed={album.id}
                cover={album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined}
                onActivate={() => void open('albums', album.id, album.title)} />}</For>
            </Show>
          </Show>
        </Show>
      }><For each={playlistNames(library().playlists ?? {}, library().settings?.playlist_order)} fallback={<EmptyState>{t('playlists.empty')}</EmptyState>}>{name =>
          <MusicListRowView title={name} subtitle={trackCount(library().playlists?.[name]?.length ?? 0)} seed={name}
            cover={props.disconnected ? undefined : (() => { const id = library().settings?.playlist_covers?.[name] ?? library().playlists?.[name]?.find(id => library().tracks.some(track => track.id === id && track.source !== 'preview')); return id ? coverUrl(id, 'thumb') : undefined; })()}
            onMenu={props.onPlaylistMenu ? event => props.onPlaylistMenu?.(name, event) : undefined} onActivate={() => { setCollection({ title: name, ids: library().playlists?.[name] ?? [], kind: 'playlists', id: name }); setQuery(''); }} />
      }</For></Show>
    }>
      <div class={styles.libraryTools}><label class={styles.field}>{t('library.searchLibrary')}<input type="search" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label>
      <Show when={props.onManageOffline}><button class={styles.menuTrigger} data-library-menu aria-label={t('songRow.ariaMore')} onClick={event => openContextMenu({ title: t('library.title'), actions: [
        { label: t(onlyAvailable() ? 'android.offlineAll' : 'android.offlineOnly'), disabled: props.disconnected, selected: onlyAvailable() || props.disconnected, onSelect: () => { detailEpoch++; setCollection(null); setOnlyAvailable(value => !value); } },
        { label: t('android.offlineManage'), onSelect: () => props.onManageOffline?.() },
        ...(tab() === 'playlists' && props.onCreatePlaylist ? [{ label: t('playlistPicker.new'), disabled: props.disconnected, onSelect: () => props.onCreatePlaylist?.() }] : []),
      ] }, event)}>⋯</button></Show></div>
      <Show when={tracks().length} fallback={<EmptyState>{t('library.emptyLibrary')}</EmptyState>}>
<VirtualBrowseRows favourite={props.isFavourite} offline={props.disconnected} onMenu={props.onMenu ? (track, event, index) => {
  const selected = collection();
  const occurrence = selected?.kind === 'playlists' && index !== undefined ? tracks().slice(0, index).filter(row => row.id === track.id).length : -1;
  const positions = selected?.ids.flatMap((id, position) => id === track.id ? [position] : []) ?? [];
  props.onMenu?.(track, event, selected?.kind === 'playlists' && positions[occurrence] !== undefined ? { playlist: selected.id, index: positions[occurrence] } : undefined);
} : undefined} tracks={tracks()} activeId={props.activeId} onPlay={props.onPlay ? index => props.onPlay?.(tracks(), index) : undefined} />
      </Show>
    </Show>
  </section>;
}
