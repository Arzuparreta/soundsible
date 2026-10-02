import { createMemo, createResource, createSignal, createEffect, on, For, Show, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { coverUrl, registerArtworkMetadata } from '../lib/media';
import { VirtualBrowseRows } from '../components/VirtualBrowseRows';
import { MusicListRowView } from '../components/MusicListRowView';
import { EmptyState } from '../components/EmptyState';
import { t } from '../lib/i18n';
import { trackCount } from '../lib/format';
import type { CatalogAlbum, CatalogArtist, PlaylistMap, Track } from '../types/music';
import styles from './AndroidStart.module.css';

export interface BrowseSnapshot { tracks: Track[]; playlists?: PlaylistMap }
/** Read-only account surface. Shares the existing row/artwork/tokens; imports no player runtime. */
export default function LibraryBrowser(props: { snapshot: BrowseSnapshot; revision: number; onPlay?: (tracks: Track[], selectedIndex: number) => void; activeId?: string }) {
  const [tab, setTab] = createSignal<'songs' | 'albums' | 'artists' | 'playlists'>('songs');
  const [collection, setCollection] = createSignal<{ title: string; ids: string[]; kind: 'albums' | 'artists' | 'playlists'; id: string } | null>(null);
  const [query, setQuery] = createSignal('');
  const [detailError, setDetailError] = createSignal(false);
  const [albums, { refetch: retryAlbums }] = createResource(() => tab() === 'albums' ? props.revision + 1 : false,
    () => request<{ albums: CatalogAlbum[] }>('/api/library/albums'));
  const [artists, { refetch: retryArtists }] = createResource(() => tab() === 'artists' ? props.revision + 1 : false,
    () => request<{ artists: CatalogArtist[] }>('/api/library/artists'));
  const tracks = createMemo(() => {
    registerArtworkMetadata(props.snapshot.tracks);
    const ids = collection()?.ids;
    const byId = new Map(props.snapshot.tracks.map(track => [track.id, track]));
    const rows = ids ? ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : props.snapshot.tracks;
    const filter = query().trim().toLocaleLowerCase();
    return filter ? rows.filter(track => `${track.title} ${track.artist} ${track.album ?? ''}`.toLocaleLowerCase().includes(filter)) : rows;
  });
  let detailEpoch = 0;
  onCleanup(() => { detailEpoch++; });
  async function open(kind: 'albums' | 'artists', id: string, title: string) {
    const epoch = ++detailEpoch;
    setDetailError(false);
    try {
      const detail = await request<{ track_ids?: string[] }>(`/api/library/${kind}/${encodeURIComponent(id)}`);
      if (epoch === detailEpoch) { setCollection({ title, ids: detail.track_ids ?? [], kind, id }); setQuery(''); }
    } catch { if (epoch === detailEpoch) setDetailError(true); }
  }
  createEffect(on(() => props.revision, () => {
    const current = collection();
    if (!current) return;
    if (current.kind === 'playlists') {
      const ids = props.snapshot.playlists?.[current.id];
      setCollection(ids ? { ...current, ids } : null);
      return;
    }
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
      <For each={['songs', 'albums', 'artists', 'playlists'] as const}>{item =>
        <button type="button" aria-pressed={tab() === item} onClick={() => selectTab(item)}>{item === 'playlists' ? t('playlists.title') : t(`library.${item}`)}</button>
      }</For>
    </nav>
    <Show when={collection()}>{item => <div><button type="button" onClick={() => { detailEpoch++; setCollection(null); }}>{t('common.back')}</button><h2>{item().title}</h2></div>}</Show>
    <Show when={detailError()}><p role="alert">{t('common.loadFailed')}</p></Show>
    <Show when={collection() || tab() === 'songs'} fallback={
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
      }><For each={Object.entries(props.snapshot.playlists ?? {})}>{([name, ids]) =>
          <MusicListRowView title={name} subtitle={trackCount(ids.length)} seed={name}
            onActivate={() => { setCollection({ title: name, ids, kind: 'playlists', id: name }); setQuery(''); }} />
      }</For></Show>
    }>
      <label class={styles.field}>{t('library.searchLibrary')}<input type="search" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label>
      <Show when={tracks().length} fallback={<EmptyState>{t('library.emptyLibrary')}</EmptyState>}>
<VirtualBrowseRows tracks={tracks()} activeId={props.activeId} onPlay={props.onPlay ? index => props.onPlay?.(tracks(), index) : undefined} />
      </Show>
    </Show>
  </section>;
}
