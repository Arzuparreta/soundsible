import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { artistPath, resolveViewMode } from '../lib/artistRoute';
import { itemArtist } from '../lib/catalogTrack';
import { coverUrl } from '../lib/media';
import { ArtistDiscoveryView, formatFans } from '../components/ArtistDiscoveryView';
import { MusicListRowView } from '../components/MusicListRowView';
import { CoverImage } from '../components/CoverImage';
import { CollectionDownloadView } from '../components/CollectionDownloadView';
import { createNativeCollection } from './collection';
import { nativeEntityMark } from './entityMarks';
import { openContextMenu } from '../lib/contextMenu';
import { openOverlay } from '../lib/overlay';
import { collectionArrivedCount, collectionStep, jobReviewCount, jobMissingCount } from '../lib/collectionState';
import type { MenuAction } from '../components/ActionMenu';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { createNativeEntityProfile, nativeProfileBookmark, type NativeEntitySubject } from './entityProfile';
import type { createNativeCatalogActions } from './catalogActions';
import type { AlbumProfile, ArtistProfile, CatalogItem, Track } from '../types/music';
import type { SavedEntity } from '../lib/savedEntityIdentity';
import styles from './AndroidStart.module.css';

/** Entity browsing owns navigation and requests; the shared controller owns native playback. */
export default function NativeEntityProfile(props: {
  subject: NativeEntitySubject; generation: number; disconnected: boolean; tracks: Track[];
  catalog: ReturnType<typeof createNativeCatalogActions>; isActive?: (track: Track) => boolean;
  onBack: () => void; onOpen: (path: string) => void;
  onEntityMenu?: (entry: SavedEntity, event?: MouseEvent) => void;
  onTrackMenu: (item: CatalogItem, event?: MouseEvent) => void;
  onReady?: () => void; onChanged: () => Promise<void>; savedEntities?: SavedEntity[];
  offlineMenuActions?: (tracks: Track[]) => MenuAction[];
}) {
  const profile = createNativeEntityProfile({ subject: () => props.subject, generation: () => props.generation, disconnected: () => props.disconnected });
  const artist = () => props.subject.kind === 'artist' ? profile.profile() as ArtistProfile | null : null;
  const album = () => props.subject.kind === 'album' ? profile.profile() as AlbumProfile | null : null;
  const context = () => { const id = props.subject.localId || props.subject.deezerId || profile.profile()?.deezer_id; return id ? { kind: props.subject.kind, id: String(id) } : undefined; };
  const [override, setOverride] = createSignal<'discover' | 'library' | null>(null);
  const [candidatesOpen, setCandidatesOpen] = createSignal(false);
  const [ids, setIds] = createSignal<string[]>([]), [libraryLoading, setLibraryLoading] = createSignal(false), [libraryError, setLibraryError] = createSignal(false);
  const [libraryRetry, setLibraryRetry] = createSignal(0);
  let disposed = false, epoch = 0;
  createEffect(on(() => [props.subject.kind, props.subject.localId, props.generation, props.disconnected, libraryRetry()] as const, ([kind, localId, generation, disconnected]) => {
    const operation = ++epoch, controller = new AbortController();
    setIds([]); setLibraryError(false); setLibraryLoading(!!localId && !disconnected);
    if (localId && !disconnected) void request<{ track_ids?: string[] }>(`/api/library/${kind === 'artist' ? 'artists' : 'albums'}/${encodeURIComponent(localId)}`, { signal: controller.signal, timeoutMs: 15000 })
      .then(result => {
        if (disposed || operation !== epoch || generation !== props.generation || controller.signal.aborted) return;
        if (!Array.isArray(result.track_ids) || result.track_ids.some(id => typeof id !== 'string')) throw new Error('Invalid collection tracks');
        setIds(result.track_ids);
      })
      .catch(() => { if (!disposed && operation === epoch && !controller.signal.aborted) setLibraryError(true); })
      .finally(() => { if (!disposed && operation === epoch) setLibraryLoading(false); });
    onCleanup(() => controller.abort());
  }));
  onCleanup(() => { disposed = true; epoch++; });
  createEffect(() => { if (!profile.loading() && !libraryLoading()) props.onReady?.(); });
  const discovered = () => artist()?.top_tracks ?? album()?.tracklist ?? [];
  const owned = createMemo(() => {
    if (props.subject.localId) {
      const tracks = new Map(props.tracks.map(track => [track.id, track]));
      return ids().map(id => tracks.get(id)).filter((track): track is Track => !!track);
    }
    const provider = props.subject.deezerId ?? profile.profile()?.deezer_id;
    const selected = new Set(discovered().flatMap(item => { const track = props.catalog.trackFor(item); return track && track.source !== 'preview' ? [track.id] : []; }));
    return props.tracks.filter(track => selected.has(track.id) || !!provider && (props.subject.kind === 'artist' ? track.deezer_artist_id === provider : track.deezer_album_id === provider));
  });
  const view = () => resolveViewMode({ urlView: props.subject.view, override: override(), canToggle: owned().length > 0 });
  const songs = () => view() === 'library' ? owned().map((track): CatalogItem => ({ id: `library:${track.id}`, type: 'library_track', source: 'library', track_id: track.id, title: track.title, artist: track.artist, raw: { ...track } }))
    : props.subject.kind === 'artist' ? discovered().slice(0, 10) : discovered();
  const bookmark = () => nativeProfileBookmark({ ...props.subject, view: view() }, profile.profile());
  const subject = () => ({ ...props.subject, deezerId: props.subject.deezerId ?? profile.profile()?.deezer_id ?? undefined });
  const collection = createNativeCollection({ subject, generation: () => props.generation, disconnected: () => props.disconnected,
    songs: discovered, owned: item => !!props.catalog.trackFor(item) && props.catalog.trackFor(item)?.source !== 'preview', refresh: props.onChanged,
    onConfirmed: job => props.catalog.adoptCollection(job, props.generation) });
  const [bookmarkError, setBookmarkError] = createSignal(false);
  let closeDetails: (() => void) | undefined;
  onCleanup(() => closeDetails?.());
  function details() {
    closeDetails?.();
    closeDetails = openOverlay(() => <CollectionDownloadView title={props.subject.name} job={collection.job()} busy={collection.busy() || props.disconnected}
      onControl={action => void collection.control(action)} onDecide={(row, candidate) => void collection.decide(row, candidate)} />, { ariaLabel: () => props.subject.name });
  }
  function collectionMenu(event?: MouseEvent) {
    const generation = props.generation, current = () => !disposed && generation === props.generation && !props.disconnected;
    const disabled = !current() || collection.busy();
    setBookmarkError(false);
    openContextMenu({ title: props.subject.name, actions: [
      nativeEntityMark(bookmark(), () => props.savedEntities ?? [], current, props.onChanged, () => { if (current()) setBookmarkError(true); }),
      ...(subject().deezerId || discovered().length ? [{ label: t('collectionControl.addSongs'), disabled, onSelect: () => { if (current()) void collection.saveSongs(); } }] : []),
      ...(subject().deezerId ? [{ label: t(props.subject.kind === 'artist' ? 'collectionControl.downloadArtist' : 'collectionControl.downloadAlbum', { title: props.subject.name }), disabled,
        onSelect: () => { if (current()) void collection.download(); } }] : []),
      ...(props.offlineMenuActions?.(owned()) ?? []),
    ] }, event);
  }
  const collectionSongs = () => props.subject.kind === 'artist' ? collection.discography() ?? [] : discovered();
  const collectionOwned = () => collectionSongs().filter(item => !!props.catalog.trackFor(item) && props.catalog.trackFor(item)?.source !== 'preview').length;
  const step = () => collectionStep({ total: collectionSongs().length, owned: collectionOwned(), job: collection.job() });
  const songRow = (item: CatalogItem, index: number, queue: CatalogItem[]) => {
    const track = () => props.catalog.trackFor(item);
    return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} seed={item.id}
      cover={track() && track()?.source !== 'preview' ? coverUrl(track()!.id, 'thumb') : item.cover}
      active={!!track() && !!props.isActive?.(track()!)} busy={props.catalog.pending() === item.id}
      disabled={props.disconnected} onActivate={() => void props.catalog.playCollection(queue, index - 1, context())} onMenu={event => props.onTrackMenu(item, event)} />;
  };
  return <section class={styles.library} data-testid="android-entity-profile">
    <button type="button" onClick={props.onBack}>{t('artist.ariaBack')}</button>
    <header>
      <h1>{props.subject.name}</h1>
      <Show when={bookmark().cover}><div style={{ position: 'relative', width: '120px', height: '120px' }}><CoverImage src={bookmark().cover} eager /></div></Show>
      <Show when={props.subject.artist}><p>{props.subject.artist}</p></Show>
      <Show when={artist()?.metadata?.nb_fans}><p>{formatFans(artist()!.metadata!.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</p></Show>
      <button type="button" aria-label={`${t('savedEntities.options')}: ${props.subject.name}`} disabled={props.disconnected || collection.busy()} onClick={collectionMenu}>⋮</button>
      <button type="button" disabled={props.disconnected || !songs().length || !!props.catalog.pending()} onClick={() => void props.catalog.playCollection(songs(), 0, context())}>{t('artist.play')}</button>
      <button type="button" disabled={props.disconnected || !songs().length || !!props.catalog.pending()} onClick={() => void props.catalog.playCollection(songs(), 0, context(), true)}>{t('artist.shuffle')}</button>
      <Show when={artist()?.candidates.length}>
        <button type="button" aria-expanded={candidatesOpen()} onClick={() => setCandidatesOpen(value => !value)}>{t('artist.notThisArtist')}</button>
        <Show when={candidatesOpen()}><For each={artist()?.candidates ?? []}>{candidate => <button disabled={props.disconnected} onClick={() => props.onOpen(artistPath(props.subject.name, { view: 'discover', deezerId: candidate.deezer_id }))}>
          {candidate.name} · {formatFans(candidate.nb_fans)}
        </button>}</For></Show>
      </Show>
      <Show when={owned().length}><nav aria-label={props.subject.name}>
        <button aria-pressed={view() === 'discover'} onClick={() => setOverride('discover')}>{t('artist.discover')}</button>
        <button aria-pressed={view() === 'library'} onClick={() => setOverride('library')}>{t('artist.library')} ({owned().length})</button>
      </nav></Show>
    </header>
    <Show when={collection.job() && step() !== 'download'}>
      <Show when={step() === 'owned'} fallback={<button type="button" data-android-collection-progress onClick={details}>
        {step() === 'downloading' ? t('collectionControl.downloading', { done: collectionArrivedCount(collection.job()), total: collection.job()?.selected_track_count ?? 0 })
          : step() === 'review' ? t('collectionControl.review', { n: jobReviewCount(collection.job()) })
          : t('collectionControl.missing', { n: jobMissingCount(collection.job()) })}
      </button>}><p role="status">{t('collectionControl.owned')}</p></Show>
    </Show>
    <Show when={collection.error() || bookmarkError()}><p role="alert">{collection.error() || t('savedEntities.failed')} <Show when={collection.error()}><button onClick={() => void collection.retry()}>{t('common.retry')}</button></Show></p></Show>
    <Show when={profile.error() || libraryError()}><p role="alert">{t('common.loadFailed')} <button onClick={() => { setLibraryRetry(value => value + 1); profile.retry(); }}>{t('common.retry')}</button></p></Show>
    <Show when={profile.profile()?.partial_failures?.length}><p role="status">{t('musicExplorer.partial')}</p></Show>
    <Show when={profile.loading() || libraryLoading()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={view() === 'discover' && artist()} fallback={<For each={songs()} fallback={<Show when={!profile.loading() && !libraryLoading()}><EmptyState>{t('artist.empty')}</EmptyState></Show>}>{(item, index) => songRow(item, index() + 1, songs())}</For>}>
      <ArtistDiscoveryView artistName={props.subject.name} topTracks={artist()?.top_tracks ?? []} albums={artist()?.albums ?? []}
        singlesEps={artist()?.singles_eps ?? []} related={artist()?.related_artists ?? []} loading={profile.loading()} renderSong={songRow}
        renderLink={link => { const tap = createResponsiveTap({ onTap: () => props.onOpen(link.entity.destination), onLongPress: () => props.onEntityMenu?.(link.entity) });
          return <button type="button" class={link.class} aria-label={link.entity.name} data-entity-destination={link.entity.destination} disabled={props.disconnected} {...tap}>{link.children}</button>; }} />
    </Show>
  </section>;
}
