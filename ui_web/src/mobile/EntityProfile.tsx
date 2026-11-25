import { CollectionToolbar, NoCollectionMatches, createCollectionSearch } from '../components/CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import type { MenuEvent } from '../lib/menuEvent';
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { artistKey, artistPath } from '../lib/artistRoute';
import { trackCount } from '../lib/format';
import { formatReleaseDate, formatTotalDuration } from '../lib/releaseFormat';
import { itemArtist } from '../lib/catalogTrack';
import { coverUrl } from '../lib/media';
import { ArtistDiscoveryView, ReleaseShelf, fansLabel, formatFans } from '../components/ArtistDiscoveryView';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { BackIcon, MoreIcon, PinIcon, PlayIcon, RadioIcon, menuIcons } from '../components/icons';
import { Control, IconButton } from '../design/Control';
import { MusicListRowView } from '../components/MusicListRowView';
import { CoverImage } from '../components/CoverImage';
import { CollectionDownloadView } from '../components/CollectionDownloadView';
import { createNativeCollection } from './collection';
import { sameEntity, type SavedEntity } from '../lib/savedEntityIdentity';
import { openContextMenu } from '../lib/contextMenu';
import { openOverlay } from '../lib/overlay';
import { collectionArrivedCount, collectionStep, jobReviewCount, jobMissingCount } from '../lib/collectionState';
import type { MenuAction } from '../components/ActionMenu';
import { EmptyState } from '../components/EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';
import { createNativeEntityProfile, nativeProfileBookmark, type NativeEntitySubject } from './entityProfile';
import type { createNativeCatalogActions } from './catalogActions';
import type { AlbumProfile, ArtistProfile, CatalogItem, Track } from '../types/music';
import styles from './AndroidStart.module.css';
import hero from '../components/EntityHero.module.css';
import profileStyles from './EntityProfile.module.css';

/** Entity browsing owns navigation and requests; the shared controller owns native playback. */
export default function NativeEntityProfile(props: {
  subject: NativeEntitySubject; generation: number; disconnected: boolean; tracks: Track[];
  catalog: ReturnType<typeof createNativeCatalogActions>; isActive?: (track: Track) => boolean;
  view?: NativeEntitySubject['view']; onViewChange?: (view: NativeEntitySubject['view']) => void;
  onBack: () => void; onOpen: (path: string) => void;
  onEntityMenu?: (entry: SavedEntity, event?: MenuEvent) => void;
  onTrackMenu: (item: CatalogItem, event?: MenuEvent) => void;
  onReady?: () => void; onChanged: () => Promise<void>; savedEntities?: SavedEntity[];
  canStartRadio?: boolean; canStartDj?: boolean;
  offlineMenuActions?: (tracks: Track[]) => MenuAction[];
}) {
  const profile = createNativeEntityProfile({ subject: () => props.subject, generation: () => props.generation, disconnected: () => props.disconnected });
  const artist = () => props.subject.kind === 'artist' ? profile.profile() as ArtistProfile | null : null;
  const album = () => props.subject.kind === 'album' ? profile.profile() as AlbumProfile | null : null;
  const context = () => { const id = props.subject.localId || props.subject.deezerId || profile.profile()?.deezer_id; return id ? { kind: props.subject.kind, id: String(id) } : undefined; };
  const view = () => props.view ?? props.subject.view;
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
  createEffect(() => { if (view() === 'library' ? !libraryLoading() : !profile.loading()) props.onReady?.(); });
  const discovered = () => artist()?.top_tracks ?? album()?.tracklist ?? [];
  const owned = createMemo(() => {
    if (props.subject.localId && props.disconnected) {
      return props.tracks.filter(track => (props.subject.kind === 'artist' ? track.artist_id : track.album_id) === props.subject.localId);
    }
    if (props.subject.localId) {
      const tracks = new Map(props.tracks.map(track => [track.id, track]));
      return ids().map(id => tracks.get(id)).filter((track): track is Track => !!track);
    }
    // Older library links can have only the names from the local track tags.
    // Resolve those from the snapshot even when the catalog cannot answer.
    const subject = props.subject;
    if (subject.view === 'library' && !subject.deezerId) {
      const name = artistKey(subject.name);
      const artist = artistKey(subject.artist);
      if (!name) return [];
      return props.tracks.filter(track => {
        if (track.source === 'preview') return false;
        if (subject.kind === 'album') {
          return artistKey(track.album) === name
            && (!artist || [track.artist, track.album_artist].some(credit => artistKey(credit) === artist));
        }
        return [track.artist, track.album_artist, ...(track.artists ?? [])].some(credit => artistKey(credit) === name);
      });
    }
    const provider = props.subject.deezerId ?? profile.profile()?.deezer_id;
    const selected = new Set(discovered().flatMap(item => { const track = props.catalog.trackFor(item); return track && track.source !== 'preview' ? [track.id] : []; }));
    return props.tracks.filter(track => selected.has(track.id) || !!provider && (props.subject.kind === 'artist' ? track.deezer_artist_id === provider : track.deezer_album_id === provider));
  });
  const songs = () => view() === 'library' ? owned().map((track): CatalogItem => ({ id: `library:${track.id}`, type: 'library_track', source: 'library', track_id: track.id, title: track.title, artist: track.artist, album: track.album ?? undefined, raw: { ...track } }))
    : props.subject.kind === 'artist' ? discovered().slice(0, 10) : discovered();
  const loading = () => view() === 'library' ? libraryLoading() : profile.loading();
  const failed = () => view() === 'library' ? libraryError() : profile.error();
  const bookmark = () => nativeProfileBookmark({ ...props.subject, view: view() }, profile.profile());
  const subject = () => ({ ...props.subject, deezerId: props.subject.deezerId ?? profile.profile()?.deezer_id ?? undefined });
  const collection = createNativeCollection({ subject, generation: () => props.generation, disconnected: () => props.disconnected,
    songs: discovered, owned: item => !!props.catalog.trackFor(item) && props.catalog.trackFor(item)?.source !== 'preview', refresh: props.onChanged,
    onConfirmed: job => props.catalog.adoptCollection(job, props.generation) });
  const [bookmarkError, setBookmarkError] = createSignal(false);
  const [bookmarkPending, setBookmarkPending] = createSignal(false);
  const bookmarked = () => (props.savedEntities ?? []).some(row => sameEntity(row, bookmark()));
  const bookmarkLabel = () => t(bookmarked() ? 'savedEntities.remove' : 'savedEntities.save');
  function toggleBookmark() {
    const generation = props.generation, current = () => !disposed && generation === props.generation && !props.disconnected;
    if (!current() || bookmarkPending()) return;
    const entry = bookmark();
    const target = !bookmarked();
    setBookmarkError(false);
    setBookmarkPending(true);
    void (async () => {
      const reply = await request<{ entities: SavedEntity[] }>('/api/library/saved-entities', { method: 'PUT', body: { entry, saved: target }, timeoutMs: 15000 });
      if (!current()) return;
      if (!Array.isArray(reply.entities) || reply.entities.some(row => sameEntity(row, entry)) !== target) throw new Error('Missing bookmark confirmation');
      await props.onChanged();
    })().catch(() => { if (current()) setBookmarkError(true); }).finally(() => { if (!disposed) setBookmarkPending(false); });
  }
  let closeDetails: (() => void) | undefined;
  onCleanup(() => closeDetails?.());
  function details() {
    closeDetails?.();
    closeDetails = openOverlay(() => <CollectionDownloadView title={props.subject.name} job={collection.job()} busy={collection.busy() || props.disconnected}
      onControl={action => void collection.control(action)} onDecide={(row, candidate) => void collection.decide(row, candidate)} />, { ariaLabel: () => props.subject.name });
  }
  function collectionMenu(event?: MenuEvent) {
    const generation = props.generation, current = () => !disposed && generation === props.generation && !props.disconnected;
    const disabled = !current() || collection.busy();
    setBookmarkError(false);
    openContextMenu({ title: props.subject.name, actions: [
      { icon: menuIcons.shuffle(), label: t('artist.shuffle'), disabled: disabled || !songs().length || !!props.catalog.pending(),
        onSelect: () => { if (current()) void props.catalog.playCollection(songs(), 0, context(), true); } },
      ...(props.subject.kind === 'artist' && props.canStartDj ? [{ icon: menuIcons.changeSession(), label: t('autoMode.startDj'),
        disabled: disabled || !songs().length || !!props.catalog.pending(),
        onSelect: () => { if (current()) void props.catalog.startDj(songs(), props.subject.name); } }] : []),
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
  const songRow = (item: CatalogItem, index: () => number, queue: () => CatalogItem[]) => {
    const track = () => props.catalog.trackFor(item);
    return <MusicListRowView playback title={item.title} subtitle={itemArtist(item)} seed={item.id}
      cover={track() && track()?.source !== 'preview' ? coverUrl(track()!.id, 'thumb') : item.cover}
      active={!!track() && !!props.isActive?.(track()!)} busy={props.catalog.pending() === item.id}
      disabled={props.disconnected} onActivate={() => void props.catalog.playCollection(queue(), index() - 1, context())} onMenu={event => props.onTrackMenu(item, event)} />;
  };
  const albumArtist = () => album()?.artist || props.subject.artist || '';
  const albumMetaParts = createMemo(() => {
    if (props.subject.kind !== 'album') return [];
    const record = album();
    const localTracks = owned();
    const parts: string[] = [];
    const year = record?.year ?? localTracks.find(track => track.year)?.year ?? undefined;
    const date = formatReleaseDate(record?.release_date, year);
    if (date) parts.push(date);
    const list = songs();
    if (list.length) parts.push(trackCount(list.length));
    const totalSec = view() === 'library' || !record
      ? localTracks.reduce((sum, tr) => sum + (tr.duration ?? 0), 0)
      : (record.duration || record.tracklist.reduce((sum, item) => sum + (item.duration ?? 0), 0));
    const runtime = formatTotalDuration(totalSec);
    if (runtime) parts.push(runtime);
    return parts;
  });
  const renderEntityLink = (link: { entity: SavedEntity; class: string; children: import('solid-js').JSX.Element }) => {
    const tap = createResponsiveTap({ onTap: () => props.onOpen(link.entity.destination), onLongPress: () => props.onEntityMenu?.(link.entity) });
    return <button type="button" class={link.class} aria-label={link.entity.name} data-entity-destination={link.entity.destination} disabled={props.disconnected} {...tap}>{link.children}</button>;
  };
  const trackSearch = createCollectionSearch();
  const matches = trackSearch.filter(songs, trackSearchFields);
  createEffect(on(view, () => trackSearch.setValue(''), { defer: true }));

  return <section class={`${styles.library} ${profileStyles.profile}`} data-testid="android-entity-profile">
    <header class={`${hero.header} ${profileStyles.header}`}>
      <button class={`${hero.back} ${profileStyles.back}`} type="button" aria-label={t('artist.ariaBack')} onClick={props.onBack}><BackIcon size={20} /></button>
      <div class={`${hero.hero} ${hero.hasCorner}`}>
        <div class={hero.art} classList={{ [hero.round]: props.subject.kind === 'artist' }}><CoverImage src={bookmark().cover} eager /></div>
        <div class={hero.identity}>
          <h1 class={`${hero.title} ${profileStyles.title}`}>{props.subject.name}</h1>
          <Show when={albumArtist()}><span class={hero.credit}>{albumArtist()}</span></Show>
          <Show when={artist()?.metadata?.nb_fans}><span class={hero.meta}>{fansLabel(artist()!.metadata!.nb_fans)}</span></Show>
          <Show when={albumMetaParts().length > 0}>
            <span class={hero.meta}>
              <For each={albumMetaParts()}>
                {(part, idx) => <><Show when={idx() > 0}><span aria-hidden="true">·</span></Show><span>{part}</span></>}
              </For>
            </span>
          </Show>
          <Show when={collection.job() && step() !== 'download'}>
            <Show when={step() === 'owned'} fallback={<button class={profileStyles.status} type="button" data-android-collection-progress onClick={details}>
              {progressLabel()}
            </button>}><span class={hero.meta} role="status">{t('collectionControl.owned')}</span></Show>
          </Show>
        </div>
        <div class={hero.corner}>
          <IconButton class={`${hero.pin} ${profileStyles.pin}`} label={bookmarkLabel()} title={bookmarkLabel()}
            aria-pressed={bookmarked()} aria-busy={bookmarkPending() || undefined}
            disabled={props.disconnected || bookmarkPending()} onClick={toggleBookmark}>
            <PinIcon size={18} filled={bookmarked()} />
          </IconButton>
        </div>
        <div class={hero.toolbar} data-entity-toolbar>
          <Show when={owned().length || view() === 'library'} fallback={<span class={hero.context}>{t(props.subject.kind === 'artist' ? 'artist.discover' : 'album.discover')}</span>}>
            <EntityViewSelect label={t('entityView.label')} value={view()}
              options={[{ value: 'discover', label: t(props.subject.kind === 'artist' ? 'artist.discover' : 'album.discover') }, { value: 'library', label: `${t('artist.library')} ${owned().length}` }]}
              onChange={value => props.onViewChange?.(value === 'library' ? 'library' : 'discover')} />
          </Show>
          <div class={hero.primaryActions}>
            <button class={`${hero.play} ${profileStyles.play}`} type="button" aria-label={t('artist.play')}
              aria-busy={!!props.catalog.pending() || undefined} disabled={props.disconnected || !songs().length || !!props.catalog.pending()}
              onClick={() => void props.catalog.playCollection(songs(), 0, context())}><PlayIcon size={20} /><span class={hero.primaryLabel}>{t('artist.play')}</span></button>
            <Show when={props.subject.kind === 'artist' && props.canStartRadio}>
              <Control class={`${hero.secondary} ${profileStyles.secondary}`} aria-label={t('trackActions.startRadio')}
                aria-busy={!!props.catalog.pending() || undefined}
                disabled={props.disconnected || !songs().length || !!props.catalog.pending()}
                onClick={() => void props.catalog.startRadio(songs())}>
                <RadioIcon size={18} /><span class={hero.primaryLabel}>{t('trackActions.startRadio')}</span>
              </Control>
            </Show>
          </div>
          <button class={`${hero.options} ${profileStyles.options}`} type="button" aria-label={`${t('savedEntities.options')}: ${props.subject.name}`}
            aria-haspopup="dialog" disabled={props.disconnected || collection.busy()} onClick={collectionMenu}><MoreIcon size={20} /></button>
        </div>
      </div>
    </header>
    <Show when={collection.error() || bookmarkError()}><p role="alert">{collection.error() || t('savedEntities.failed')} <Show when={collection.error()}><button onClick={() => void collection.retry()}>{t('common.retry')}</button></Show></p></Show>
    <Show when={failed()}><p role="alert">{t('common.loadFailed')} <button onClick={() => { if (view() === 'library') setLibraryRetry(value => value + 1); else profile.retry(); }}>{t('common.retry')}</button></p></Show>
    <Show when={profile.profile()?.partial_failures?.length}><p role="status">{t('musicExplorer.partial')}</p></Show>
    <Show when={loading()}><p role="status">{t('common.loading')}</p></Show>
    <Show when={view() === 'discover' && artist()} fallback={<>
      <Show when={songs().length} fallback={
        <Show when={!loading() && !failed()}><EmptyState>{t('artist.empty')}</EmptyState></Show>
      }>
        <CollectionToolbar contained search={trackSearch} />
        <For each={matches()} fallback={<NoCollectionMatches />}>{(item, index) => songRow(item, () => index() + 1, matches)}</For>
      </Show>
      <Show when={view() === 'discover' && album()?.label}>
        <p class={profileStyles.labelCredit}>℗ {album()!.label}</p>
      </Show>
      <Show when={view() === 'discover' && (album()?.more_by_artist?.length ?? 0) > 0 && albumArtist()}>
        <ReleaseShelf title={t('album.moreBy', { artist: albumArtist() })} artistName={albumArtist()} releases={album()!.more_by_artist!} renderLink={renderEntityLink} />
      </Show>
    </>}>
      <ArtistDiscoveryView artistName={props.subject.name} topTracks={artist()?.top_tracks ?? []} albums={artist()?.albums ?? []}
        singlesEps={artist()?.singles_eps ?? []} latestRelease={artist()?.latest_release ?? null} related={artist()?.related_artists ?? []} loading={profile.loading()} renderSong={songRow}
        renderLink={renderEntityLink} />
    </Show>
  </section>;
}
