import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { artistPath, resolveViewMode } from '../lib/artistRoute';
import { itemArtist } from '../lib/catalogTrack';
import { coverUrl } from '../lib/media';
import { ArtistDiscoveryView, fansLabel, formatFans } from '../components/ArtistDiscoveryView';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { BackIcon, MoreIcon, PlayIcon, menuIcons } from '../components/icons';
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
import hero from '../components/EntityHero.module.css';
import profileStyles from './EntityProfile.module.css';

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
      { icon: menuIcons.shuffle(), label: t('artist.shuffle'), disabled: disabled || !songs().length || !!props.catalog.pending(),
        onSelect: () => { if (current()) void props.catalog.playCollection(songs(), 0, context(), true); } },
      nativeEntityMark(bookmark(), () => props.savedEntities ?? [], current, props.onChanged, () => { if (current()) setBookmarkError(true); }),
      ...(subject().deezerId || discovered().length ? [{ label: t('collectionControl.addSongs'), disabled, onSelect: () => { if (current()) void collection.saveSongs(); } }] : []),
      ...(subject().deezerId ? [{ label: t(props.subject.kind === 'artist' ? 'collectionControl.downloadArtist' : 'collectionControl.downloadAlbum', { title: props.subject.name }), disabled,
        onSelect: () => { if (current()) void collection.download(); } }] : []),
      ...(props.offlineMenuActions?.(owned()) ?? []),
      ...(collection.job() && ['downloading', 'review', 'missing'].includes(step()) ? [{ label: progressLabel(), onSelect: details }] : []),
      ...(artist()?.candidates.length ? [{ label: t('artist.notThisArtist'), onSelect: () => openContextMenu({ title: t('artist.notThisArtist'),
        actions: (artist()?.candidates ?? []).map(candidate => ({ label: `${candidate.name} · ${formatFans(candidate.nb_fans)}`,
          onSelect: () => { if (current()) props.onOpen(artistPath(props.subject.name, { view: 'discover', deezerId: candidate.deezer_id })); } })) }) }] : []),
    ] }, event);
  }
  const collectionSongs = () => props.subject.kind === 'artist' ? collection.discography() ?? [] : discovered();
  const collectionOwned = () => collectionSongs().filter(item => !!props.catalog.trackFor(item) && props.catalog.trackFor(item)?.source !== 'preview').length;
  const step = () => collectionStep({ total: collectionSongs().length, owned: collectionOwned(), job: collection.job() });
  const progressLabel = () => step() === 'downloading'
    ? t('collectionControl.downloading', { done: collectionArrivedCount(collection.job()), total: collection.job()?.selected_track_count ?? 0 })
    : step() === 'review' ? t('collectionControl.review', { n: jobReviewCount(collection.job()) })
    : t('collectionControl.missing', { n: jobMissingCount(collection.job()) });
  const songRow = (item: CatalogItem, index: number, queue: CatalogItem[]) => {
    const track = () => props.catalog.trackFor(item);
    return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} seed={item.id}
      cover={track() && track()?.source !== 'preview' ? coverUrl(track()!.id, 'thumb') : item.cover}
      active={!!track() && !!props.isActive?.(track()!)} busy={props.catalog.pending() === item.id}
      disabled={props.disconnected} onActivate={() => void props.catalog.playCollection(queue, index - 1, context())} onMenu={event => props.onTrackMenu(item, event)} />;
  };
  return <section class={`${styles.library} ${profileStyles.profile}`} data-testid="android-entity-profile">
    <header class={`${hero.header} ${profileStyles.header}`}>
      <button class={`${hero.back} ${profileStyles.back}`} type="button" aria-label={t('artist.ariaBack')} onClick={props.onBack}><BackIcon size={20} /></button>
      <div class={hero.hero}>
        <div class={hero.art} classList={{ [hero.round]: props.subject.kind === 'artist' }}><CoverImage src={bookmark().cover} eager /></div>
        <div class={hero.identity}>
          <h1 class={`${hero.title} ${profileStyles.title}`}>{props.subject.name}</h1>
          <Show when={props.subject.artist}><span class={hero.credit}>{props.subject.artist}</span></Show>
          <Show when={artist()?.metadata?.nb_fans}><span class={hero.meta}>{fansLabel(artist()!.metadata!.nb_fans)}</span></Show>
          <Show when={collection.job() && step() !== 'download'}>
            <Show when={step() === 'owned'} fallback={<button class={profileStyles.status} type="button" data-android-collection-progress onClick={details}>
              {progressLabel()}
            </button>}><span class={hero.meta} role="status">{t('collectionControl.owned')}</span></Show>
          </Show>
        </div>
        <div class={hero.toolbar} data-entity-toolbar>
          <Show when={owned().length} fallback={<span class={hero.context}>{t('artist.discover')}</span>}>
            <EntityViewSelect label={t('entityView.label')} value={view()}
              options={[{ value: 'discover', label: t('artist.discover') }, { value: 'library', label: `${t('artist.library')} ${owned().length}` }]}
              onChange={value => setOverride(value === 'library' ? 'library' : 'discover')} />
          </Show>
          <button class={`${hero.play} ${profileStyles.play}`} type="button" aria-label={t('artist.play')}
            aria-busy={!!props.catalog.pending() || undefined} disabled={props.disconnected || !songs().length || !!props.catalog.pending()}
            onClick={() => void props.catalog.playCollection(songs(), 0, context())}><PlayIcon size={20} /><span class={hero.primaryLabel}>{t('artist.play')}</span></button>
          <button class={`${hero.options} ${profileStyles.options}`} type="button" aria-label={`${t('savedEntities.options')}: ${props.subject.name}`}
            aria-haspopup="dialog" disabled={props.disconnected || collection.busy()} onClick={collectionMenu}><MoreIcon size={20} /></button>
        </div>
      </div>
    </header>
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
