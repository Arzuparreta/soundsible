import { CollectionToolbar, NoCollectionMatches, createCollectionSearch } from '../components/CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import { EntityHero, EntityMenuCover } from '../components/EntityHero';
import { CollectionControl, EntityBookmarkButton } from '../components/CollectionControl';
import Button from '../components/Button';
import { CollectionActions } from '../components/CollectionActions';
import { PlayIcon, menuIcons } from '../components/icons';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { ArtistLinks, MusicLink } from '../components/MusicLinks';
import { createEffect, createMemo, createResource, createSignal, For, on, Show, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { musicLibrary, isPlayingItem, state } from '../stores';
import { player } from '../stores/player';
import { api } from '../lib/api';
import { coverUrl, hasCoverArt, trackCoverUrl } from '../lib/media';
import { catalogItemKeys } from '../lib/playbackIdentity';
import { trackCount } from '../lib/format';
import { formatReleaseDate, formatTotalDuration } from '../lib/releaseFormat';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { albumPath, artistKey, artistPath, decodeArtistName, parseViewParams } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumProfile, AlbumSummary, CatalogAlbum, CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { useCatalogCollection, itemArtist, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import { startDjFromCatalog, startDjFromTracks } from '../lib/djStart';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Album.module.css';
import hero from '../components/EntityHero.module.css';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { ReleaseShelf } from '../components/ArtistDiscoveryView';
import { openSavedEntityMenu } from '../components/savedEntityActions';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { EntityTrackList } from '../components/EntityTrackList';
import { tabRoot } from '../lib/tabMemory';

type ViewMode = 'discover' | 'library';

/** What the engine answered about this record in the library. A failed read is
 * kept apart from an empty one: only the second means "not owned". */
type Membership = { ok: true; album: CatalogAlbum; trackIds: string[] } | { ok: false };

/** Album detail page with discover/library toggle.
 * Reached by tapping an album card from the artist page or search. */
export default function Album() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const title = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));
  const artistName = createMemo(() => (searchParams as Record<string, string | undefined>).artist || '');

  const [saving, setSaving] = createSignal<Set<string>>(new Set());

  let aborter: AbortController | undefined;

  const fetchAlbum = async (albumTitle: string, albumArtist: string, deezerId?: string): Promise<AlbumProfile | null> => {
    aborter?.abort();
    aborter = new AbortController();
    try {
      return await api.getAlbumProfile(albumTitle, albumArtist, deezerId, aborter.signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  };

  const [profileError, setProfileError] = createSignal(false);
  // Compared by value: switching Discover / My library rewrites the query
  // string, and a fresh object each time fetched the record again and blanked
  // the page under the user's tap.
  const profileKey = createMemo(() => ({ t: title(), a: artistName(), id: viewParams().deezerId }), undefined,
    { equals: (a, b) => a.t === b.t && a.a === b.a && a.id === b.id });
  const [profile, { refetch: retryProfile }] = createResource(
    profileKey,
    async (args) => {
      setProfileError(false);
      try { return await fetchAlbum(args.t, args.a, args.id); }
      catch { setProfileError(true); return null; }
    },
  );

  const currentProfile = () => profile.loading ? null : profile();

  onCleanup(() => {
    aborter?.abort();
    cancelCatalogResolve();
  });

  // Which songs are on a record is the engine's answer, and a catalog id in the
  // link is what lets us ask for it. Matching on the title is how two different
  // records called "Greatest Hits" used to play as one, and how a compilation
  // lost the tracks whose credits did not repeat the album artist.
  //
  // The fallback stays for links that carry no id — a Deezer result, an album
  // named in search — where a name is genuinely all there is. A link with an id
  // never falls back to it, not even when the read fails: the page says so and
  // retries the same id instead.
  const [membership, { refetch: retryMembership }] = createResource(
    () => viewParams().albumId,
    (albumId): Promise<Membership> => api.getLibraryAlbum(albumId).then(
      (res) => ({ ok: true, album: res.album, trackIds: res.track_ids ?? [] }),
      () => ({ ok: false }),
    ),
  );
  const membershipRead = () => {
    // A disabled resource retains its last result. A name-only link must not
    // inherit another record's artwork, credits or year from that result.
    if (!viewParams().albumId) return undefined;
    const read = membership.loading ? undefined : membership();
    return read?.ok ? read : undefined;
  };
  const membershipFailed = () => !!viewParams().albumId && !membership.loading && membership()?.ok === false;

  const libraryTrackList = createMemo<Track[]>(() => {
    if (viewParams().albumId) return tracksByIds(membershipRead()?.trackIds ?? []);
    // artistKey folds the same Unicode/casing differences on both sides; the
    // album title is matched with it too so the two comparisons stay consistent.
    const tKey = artistKey(title());
    const aKey = artistKey(artistName());
    if (!tKey) return [];
    return musicLibrary().filter((t) => {
      const matchAlbum = artistKey(t.album) === tKey;
      const matchArtist = artistKey(t.artist) === aKey || artistKey(t.album_artist) === aKey;
      return matchAlbum && (aKey ? matchArtist : true);
    });
  });

  const tracklist = createMemo<CatalogItem[]>(() => currentProfile()?.tracklist ?? []);
  // A library link (it carries the record's catalog id) keeps its library tab
  // while the read is pending or after it failed; only an answered empty read
  // says the record is no longer owned.
  const inLibrary = createMemo(() => {
    if (viewParams().albumId) {
      if (membership.loading || membershipFailed()) return true;
      return (membershipRead()?.trackIds.length ?? 0) > 0;
    }
    return currentProfile()?.in_library ?? libraryTrackList().length > 0;
  });
  const showToggle = createMemo(() => inLibrary() || viewParams().view === 'library');

  const view = () => viewParams().view;

  /** The sleeve the user owns: the catalog's cover track, else the first owned
   * song with artwork. */
  const localCover = createMemo(() => {
    const coverTrack = membershipRead()?.album.cover_track_id;
    if (coverTrack) return coverUrl(coverTrack);
    const track = libraryTrackList().find((tr) => hasCoverArt(tr));
    return track ? trackCoverUrl(track) : undefined;
  });
  /** The library copy shows its own sleeve; the catalogue listing shows the
   * catalogue's, and either falls back to the other when it has none. */
  const cover = () => view() === 'library'
    ? localCover() || currentProfile()?.cover || undefined
    : currentProfile()?.cover || localCover();
  /** What the shown tab holds: the owned songs, or the catalogue listing. */
  const shownCount = () => view() === 'library'
    ? (membership.loading || membershipFailed() ? undefined : libraryTrackList().length)
    : tracklist().length || undefined;
  const year = () => currentProfile()?.year ?? membershipRead()?.album.year ?? undefined;
  const displayArtist = () => currentProfile()?.artist || artistName();
  // Only the profile's structured list: a name such as "Earth, Wind & Fire"
  // must never be split on its comma.
  const displayArtists = () => currentProfile()?.artists?.length ? currentProfile()!.artists : undefined;
  const displayTitle = () => currentProfile()?.title || title();
  const totalDuration = () => {
    if (view() === 'library') {
      if (membership.loading || membershipFailed()) return 0;
      return membershipRead()?.album.duration || libraryTrackList().reduce((sum, tr) => sum + (tr.duration ?? 0), 0);
    }
    return currentProfile()?.duration || tracklist().reduce((sum, item) => sum + (item.duration ?? 0), 0);
  };
  const metaParts = createMemo(() => {
    const parts: string[] = [];
    const date = formatReleaseDate(currentProfile()?.release_date, year());
    if (date) parts.push(date);
    const n = shownCount();
    if (n) parts.push(trackCount(n));
    const runtime = formatTotalDuration(totalDuration());
    if (runtime) parts.push(runtime);
    return parts;
  });

  /**
   * This record as a context, for the tab it is played from. The queue's card
   * leads back here, to the same tab — the library copy and the catalog
   * listing are not the same list of songs.
   */
  const albumContext = (mode: ViewMode = view()): PlaybackContextDescriptor => ({
    id: `album:${title()}`,
    kind: 'album',
    label: title(),
    cover: cover(),
    destination: albumPath(title(), artistName(), {
      view: mode,
      albumId: mode === 'library' ? viewParams().albumId : undefined,
      deezerId: viewParams().deezerId,
    }),
  });

  const playAll = () => {
    const context = albumContext();
    if (player().autoMode.active) {
      // An album is one source for the DJ, never a list of requests.
      if (view() === 'library') void player().actions.startDjSelection(libraryTrackList(), title());
      else void useCatalogCollection(tracklist(), title(), 'start');
      return;
    }
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) player().actions.playFrom(tracks, 0, { context });
    } else {
      const items = tracklist();
      if (items.length === 0) return;
      void playCatalogItem(items[0], items, context);
    }
  };

  /** From NORMAL, the same start the DJ's own Play button makes. */
  const startAlbumDj = () => {
    if (view() === 'library') startDjFromTracks(libraryTrackList(), title());
    else void startDjFromCatalog(tracklist(), title());
  };

  const shuffle = () => {
    const context = albumContext();
    if (player().autoMode.active) {
      if (view() === 'library') void player().actions.startDjSelection(libraryTrackList(), title());
      else void useCatalogCollection(tracklist(), title(), 'start');
      return;
    }
    if (view() === 'library') {
      player().actions.playShuffled(libraryTrackList(), context);
    } else {
      const items = tracklist();
      if (items.length === 0) return;
      const order = shuffled(items);
      void playCatalogItem(order[0], order, context);
    }
  };

  /** This record, as the place a downloaded song is filed: without it the
   * song lands under whatever release YouTube tags it with, as its track 1. */
  const albumEvidence = (item: CatalogItem) => {
    const profile = currentProfile();
    if (!profile?.resolved) return {};
    const position = (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined);
    return {
      album: profile.title || title(),
      album_artist: profile.artist || artistName() || undefined,
      track_number: position(item.raw?.track_number),
      disc_number: position(item.raw?.disc_number),
      year: profile.year ?? undefined,
    };
  };

  const saveItem = async (item: CatalogItem) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    setSaving((s) => new Set(s).add(item.id));
    try {
      const response = await api.saveCatalogItem({
        catalog_item_id: item.id,
        source: item.source,
        artist,
        title: item.title,
        duration: item.duration,
        cover: item.cover,
        external_ids: item.external_ids,
        identity_keys: catalogItemKeys(item),
        ...albumEvidence(item),
      });
      if (response.status === 'queued') {
        toast.success(t('search.addedToDownloads'));
      } else if (response.status === 'needs_review') {
        toast.info(t('search.chooseVersion'));
      } else {
        toast.error(t('search.notSaved'));
      }
    } catch {
      toast.error(t('search.notSaved'));
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const switchView = (mode: ViewMode) => {
    setSearchParams({ view: mode }, { replace: true });
  };

  const back = () => navigateBackOr(
    navigate,
    view() === 'library'
      ? (tabRoot('/') ?? '/')
      : (tabRoot('/search') ?? (artistName() ? artistPath(artistName(), { view: 'discover' }) : '/search')),
  );
  let openCollectionMenu = () => {};
  const playable = () => view() === 'library' ? libraryTrackList().length > 0 : tracklist().length > 0;

  const entity = () => ({
    kind: 'album' as const,
    name: title(),
    artist: artistName(),
    cover: cover(),
    destination: albumPath(title(), artistName(), { view: view(), albumId: viewParams().albumId, deezerId: viewParams().deezerId }),
  });

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => view() === 'library' ? !membership.loading : !profile.loading)}
        class={hero.page}
        data-primary-scroll
      >
        <EntityHero name={displayTitle()} back={back} backLabel={t('album.ariaBack')}
          openMenu={() => openCollectionMenu()}
          corner={<EntityBookmarkButton entity={entity()} />}
          art={<EntityMenuCover name={displayTitle()} cover={cover()} onOpen={() => openCollectionMenu()} />}
          metadata={<>
            <ArtistLinks class={hero.credit} music={{ artist: displayArtist(), artists: displayArtists(), view: view(), artistId: membershipRead()?.album.album_artist_id ?? undefined }} />
            <span class={hero.meta}>
              <For each={metaParts()}>
                {(part, idx) => (
                  <>
                    <Show when={idx() > 0}><span aria-hidden="true">·</span></Show>
                    <span>{part}</span>
                  </>
                )}
              </For>
            </span>
          </>}>
          <div class={hero.toolbar} data-entity-toolbar>
            <Show when={showToggle()} fallback={<span class={hero.context}>{t('album.discover')}</span>}>
              <EntityViewSelect label={t('entityView.label')} value={view()} onChange={value => switchView(value as ViewMode)}
                options={[
                  { value: 'discover', label: t('album.discover') },
                  { value: 'library', label: `${t('album.library')}${membership.loading || membershipFailed() ? '' : ` (${libraryTrackList().length})`}` },
                ]} />
            </Show>
            <Show when={player().autoMode.active} fallback={
              <button class={hero.play} type="button" aria-label={t('album.play')} title={t('album.play')} disabled={!playable()} onClick={playAll}>
                <PlayIcon size={16} />
                <span class={hero.primaryLabel}>{t('album.play')}</span>
              </button>
            }>
              <CollectionActions title={title()} iconOnlyOnMobile buttonClass={hero.play}
                tracks={view() === 'library' ? libraryTrackList() : undefined}
                items={view() === 'library' ? undefined : tracklist()} />
            </Show>
            <CollectionControl
              compact menuActions={() => !player().autoMode.active
                ? [
                    { icon: menuIcons.shuffle(), label: t('album.shuffle'), disabled: !playable(), onSelect: shuffle },
                    { icon: menuIcons.changeSession(), label: t('autoMode.startDj'), disabled: !playable(), onSelect: startAlbumDj },
                  ] : []}
              onMenuReady={(open) => { openCollectionMenu = open; }}
              entity={entity()}
              tracklist={tracklist()}
              deezerId={viewParams().deezerId ?? currentProfile()?.deezer_id ?? undefined} />
          </div>
        </EntityHero>

        <Show
          when={view() === 'discover' && profile.loading && !currentProfile()}
          fallback={
            <Show
              when={view() === 'library' || currentProfile()}
              fallback={<EmptyState tone={profileError() ? 'danger' : undefined}>{profileError() ? t('common.loadFailed') : t('album.noTracklist')} <Show when={profileError()}><Button class={hero.retry} variant="secondary" size="sm" onClick={() => void retryProfile()}>{t('common.retry')}</Button></Show></EmptyState>}
            >
              <Show when={view() === 'discover'} fallback={
                <Show when={!membershipFailed()} fallback={
                  <EmptyState tone="danger">{t('common.loadFailed')} <Button class={hero.retry} variant="secondary" size="sm" onClick={() => void retryMembership()}>{t('common.retry')}</Button></EmptyState>
                }>
                  <Show when={!membership.loading && !state.loading} fallback={<SkeletonRows />}><LibraryView tracks={libraryTrackList()} context={albumContext('library')} /></Show>
                </Show>
              }>
                <DiscoverView
                  subject={profileKey()}
                  tracklist={tracklist()}
                  label={currentProfile()?.label || ''}
                  artistName={displayArtist()}
                  moreByArtist={currentProfile()?.more_by_artist ?? []}
                  saving={saving()}
                  onPlayItem={(item, queue) => void playCatalogItem(item, queue, albumContext('discover'))}
                  onSaveItem={saveItem}
                />
              </Show>
            </Show>
          }
        >
          <SkeletonRows count={8} />
        </Show>
      </div>
    </div>
  );
}

function LibraryView(props: { tracks: Track[]; context: PlaybackContextDescriptor }) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracks.length > 0} fallback={<EmptyState>{t('album.empty')}</EmptyState>}>
        <EntityTrackList tracks={props.tracks} context={props.context} />
      </Show>
    </div>
  );
}

function DiscoverView(props: {
  subject: object;
  tracklist: CatalogItem[];
  label: string;
  artistName: string;
  moreByArtist: AlbumSummary[];
  saving: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
}) {
  const search = createCollectionSearch();
  const tracks = search.filter(() => props.tracklist, trackSearchFields);
  const position = search.positions(() => props.tracklist);
  createEffect(on(() => props.subject, () => search.setValue(''), { defer: true }));
  return (
    <div class={styles.contentView}>
      <Show when={props.tracklist.length > 0} fallback={<EmptyState>{t('album.noTracklist')}</EmptyState>}>
        <CollectionToolbar search={search} />
        <Show when={tracks().length} fallback={<NoCollectionMatches />}>
        <div class={styles.trackList}>
          <For each={tracks()}>
            {(item) => (
              <CatalogResultRow
                item={item}
                index={position(item)}
                active={isPlayingItem(item)}
                saving={props.saving.has(item.id)}
                onPlay={() => props.onPlayItem(item, tracks())}
                onDownload={() => props.onSaveItem(item)}
              />
            )}
          </For>
        </div>
        </Show>
      </Show>
      <Show when={props.label}>
        <p class={styles.labelCredit}>℗ {props.label}</p>
      </Show>
      <Show when={props.moreByArtist.length > 0 && props.artistName}>
        <ReleaseShelf
          title={t('album.moreBy', { artist: props.artistName })}
          artistName={props.artistName}
          releases={props.moreByArtist}
          renderLink={link => (
            <MusicLink class={link.class} path={link.entity.destination} onMenu={event => void openSavedEntityMenu(link.entity, event)}>
              {link.children}
            </MusicLink>
          )}
        />
      </Show>
    </div>
  );
}
