import { createResponsiveTap } from '../lib/responsiveTap';
import { CollectionControl } from '../components/CollectionControl';
import Button from '../components/Button';
import { CollectionActions } from '../components/CollectionActions';
import { BackIcon, PlayIcon, menuIcons } from '../components/icons';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { CoverImage } from '../components/CoverImage';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { ArtistLinks } from '../components/MusicLinks';
import { createEffect, createMemo, createResource, createSignal, For, on, Show, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { actions, musicLibrary, isPlayingItem, state } from '../stores';
import { api } from '../lib/api';
import { coverUrl, hasCoverArt, trackCoverUrl } from '../lib/media';
import { catalogItemKeys } from '../lib/playbackIdentity';
import { trackCount } from '../lib/format';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { albumPath, artistKey, artistPath, decodeArtistName, parseViewParams, resolveViewMode } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumProfile, CatalogAlbum, CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { useCatalogCollection, itemArtist, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Album.module.css';
import hero from '../components/EntityHero.module.css';
import { coverGradient } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SongRow from '../components/SongRow';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
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
  const [viewOverride, setViewOverride] = createSignal<ViewMode | null>(null);
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
  const showToggle = createMemo(() => inLibrary());

  // See Artist.tsx: the router reuses this component across :name changes, so
  // the tab is derived from the URL rather than held in a mount-seeded signal,
  // and forced to discover whenever the toggle is hidden.
  createEffect(
    on(
      () => JSON.stringify([title(), artistName(), viewParams().deezerId ?? '']),
      () => setViewOverride(null),
      { defer: true },
    ),
  );
  const view = createMemo<ViewMode>(() =>
    resolveViewMode({ urlView: viewParams().view, override: viewOverride(), canToggle: showToggle() }),
  );

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
  const displayTitle = () => currentProfile()?.title || title();

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
    if (state.autoMode.active) {
      // An album is one source for the DJ, never a list of requests.
      if (view() === 'library') void actions.startDjSelection(libraryTrackList(), title());
      else void useCatalogCollection(tracklist(), title(), 'start');
      return;
    }
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) actions.playFrom(tracks, 0, { context });
    } else {
      const items = tracklist();
      if (items.length === 0) return;
      void playCatalogItem(items[0], items, context);
    }
  };

  const shuffle = () => {
    const context = albumContext();
    if (state.autoMode.active) {
      if (view() === 'library') void actions.startDjSelection(libraryTrackList(), title());
      else void useCatalogCollection(tracklist(), title(), 'start');
      return;
    }
    if (view() === 'library') {
      actions.playShuffled(libraryTrackList(), context);
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
    setViewOverride(mode);
    setSearchParams({ view: mode }, { replace: true });
  };

  // A page with no way back in history sits on the search it belongs to; a
  // record opened cold, with no search behind it, climbs to its artist.
  const back = () => navigateBackOr(
    navigate,
    tabRoot('/search') ?? (artistName() ? artistPath(artistName(), { view: 'discover' }) : '/search'),
  );
  let openCollectionMenu = () => {};
  const coverMenuTap = createResponsiveTap({ onTap: () => openCollectionMenu(), onLongPress: () => openCollectionMenu() });
  const titleMenuTap = createResponsiveTap({ onTap: () => openCollectionMenu(), onLongPress: () => openCollectionMenu() });
  const headerContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openCollectionMenu();
  };
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({
    title: () => currentProfile()?.title || title(),
    back,
    backLabel: () => t('album.ariaBack'),
    heading,
  });

  const playable = () => view() === 'library' ? libraryTrackList().length > 0 : tracklist().length > 0;

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => !profile.loading)}
        class={hero.page}
        data-primary-scroll
      >
        <header class={hero.header}>
        <Show when={desktopShell()}>
          <button class={hero.back} type="button" aria-label={t('album.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>

        <div class={hero.hero}>
          <button type="button" class={hero.art} data-testid="collection-header-cover"
            aria-label={`${t('savedEntities.options')}: ${displayTitle()}`} aria-haspopup="dialog"
            {...coverMenuTap} onContextMenu={headerContextMenu} style={{ background: coverGradient(title()) }}>
            <CoverImage src={cover()} eager />
            <Show when={!cover()}>
              <span class={hero.initial} aria-hidden="true">{(title()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </button>
          <div class={hero.identity}>
            <h1 ref={setHeading} class={hero.title}><button type="button" class={hero.titleButton}
              data-testid="collection-header-name" aria-haspopup="dialog" title={t('savedEntities.options')}
              {...titleMenuTap} onContextMenu={headerContextMenu}>{displayTitle()}</button></h1>
            <ArtistLinks class={hero.credit} music={{ artist: currentProfile()?.artist || artistName(), view: view(), artistId: membershipRead()?.album.album_artist_id ?? undefined }} />
            <span class={hero.meta}>
              <Show when={year()}><span>{year()}</span></Show>
              <Show when={year() && shownCount()}><span aria-hidden="true">·</span></Show>
              <Show when={shownCount()}>{(n) => <span>{trackCount(n())}</span>}</Show>
            </span>
          </div>
          <div class={hero.toolbar} data-entity-toolbar>
            <Show when={showToggle()} fallback={<span class={hero.context}>{t('album.discover')}</span>}>
              <EntityViewSelect label={t('entityView.label')} value={view()} onChange={value => switchView(value as ViewMode)}
                options={[
                  { value: 'discover', label: t('album.discover') },
                  { value: 'library', label: `${t('album.library')}${membership.loading || membershipFailed() ? '' : ` (${libraryTrackList().length})`}` },
                ]} />
            </Show>
            <Show when={state.autoMode.active} fallback={
              <button class={hero.play} type="button" aria-label={t('album.play')} title={t('album.play')} disabled={!playable()} onClick={playAll}>
                <PlayIcon size={16} />
                <span class={hero.primaryLabel}>{t('album.play')}</span>
              </button>
            }>
              <CollectionActions title={title()} auto iconOnlyOnMobile buttonClass={hero.play}
                tracks={view() === 'library' ? libraryTrackList() : undefined}
                items={view() === 'library' ? undefined : tracklist()} />
            </Show>
            <CollectionControl
              compact menuActions={() => !state.autoMode.active
                ? [{ icon: menuIcons.shuffle(), label: t('album.shuffle'), disabled: !playable(), onSelect: shuffle }] : []}
              onMenuReady={(open) => { openCollectionMenu = open; }}
              entity={{ kind: 'album', name: title(), artist: artistName(), cover: cover(), destination: albumPath(title(), artistName(), { view: view(), albumId: viewParams().albumId, deezerId: viewParams().deezerId }) }}
              tracklist={tracklist()}
              deezerId={viewParams().deezerId ?? currentProfile()?.deezer_id ?? undefined} />
          </div>
        </div>

        </header>

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
                  tracklist={tracklist()}
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
        <TrackListLite tracks={props.tracks} context={props.context} />
      </Show>
    </div>
  );
}

function TrackListLite(props: { tracks: Track[]; context: PlaybackContextDescriptor }) {
  return (
    <div class={styles.trackList}>
      <For each={props.tracks}>
        {(track, i) => (
          <SongRow
            track={track} music={libraryTrackMusic(track)}
            index={i() + 1}
            cover={trackCoverUrl(track, 'thumb')}
            onPlay={() => actions.playFrom(props.tracks, i(), { context: props.context })}
          />
        )}
      </For>
    </div>
  );
}

function DiscoverView(props: {
  tracklist: CatalogItem[];
  saving: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
}) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracklist.length > 0} fallback={<EmptyState>{t('album.noTracklist')}</EmptyState>}>
        <div class={styles.trackList}>
          <For each={props.tracklist}>
            {(item, i) => (
              <CatalogResultRow
                item={item}
                index={i() + 1}
                active={isPlayingItem(item)}
                saving={props.saving.has(item.id)}
                onPlay={() => props.onPlayItem(item, props.tracklist)}
                onDownload={() => props.onSaveItem(item)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
