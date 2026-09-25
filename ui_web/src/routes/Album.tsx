import Button from '../components/Button';
import { CollectionActions } from '../components/CollectionActions';
import { BackIcon, PlayIcon, ShuffleIcon } from '../components/icons';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { CoverImage } from '../components/CoverImage';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { ArtistLinks } from '../components/MusicLinks';
import { createEffect, createMemo, createResource, createSignal, For, on, Show, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { actions, musicLibrary, isPlayingItem, state } from '../stores';
import { api } from '../lib/api';
import { trackCoverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { albumPath, artistKey, artistPath, decodeArtistName, parseViewParams, resolveViewMode } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumProfile, CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { useCatalogCollection, itemArtist, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Album.module.css';
import { coverGradient } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SongRow from '../components/SongRow';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';

type ViewMode = 'discover' | 'library';

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
  const [profile, { refetch: retryProfile }] = createResource(
    () => ({ t: title(), a: artistName(), id: viewParams().deezerId }),
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
  // named in search — where a name is genuinely all there is.
  const [catalogTracks] = createResource(
    () => viewParams().albumId,
    (albumId) => api.getLibraryAlbum(albumId).catch(() => null),
  );

  const libraryTrackList = createMemo<Track[]>(() => {
    if (viewParams().albumId) return tracksByIds(catalogTracks.loading ? [] : catalogTracks()?.track_ids ?? []);
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
  const inLibrary = createMemo(() => currentProfile()?.in_library ?? libraryTrackList().length > 0);
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

  /**
   * This record as a context, for the tab it is played from. The queue's card
   * leads back here, to the same tab — the library copy and the catalog
   * listing are not the same list of songs.
   */
  const albumContext = (mode: ViewMode = view()): PlaybackContextDescriptor => ({
    id: `album:${title()}`,
    kind: 'album',
    label: title(),
    cover: currentProfile()?.cover || undefined,
    destination: albumPath(title(), artistName(), {
      view: mode,
      albumId: mode === 'library' ? viewParams().albumId : undefined,
      deezerId: viewParams().deezerId,
    }),
  });

  const playAll = () => {
    const context = albumContext();
    if (state.autoMode.active) {
      if (view() === 'library') void actions.placeAutoTracks(libraryTrackList());
      else void useCatalogCollection(tracklist(), title(), 'request');
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
      if (view() === 'library') void actions.placeAutoTracks(libraryTrackList());
      else void useCatalogCollection(tracklist(), title(), 'request');
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

  const back = () => navigateBackOr(
    navigate,
    artistName() ? artistPath(artistName(), { view: 'discover' }) : '/search',
  );
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({
    title: () => currentProfile()?.title || title(),
    back,
    backLabel: () => t('album.ariaBack'),
    heading,
  });

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => !profile.loading)}
        class={styles.pageScroll}
        data-primary-scroll
      >
        <header class={styles.header}>
        <Show when={desktopShell()}>
          <button class={styles.back} type="button" aria-label={t('album.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>

        <div class={styles.hero}>
          <div class={styles.cover} style={{ position: 'relative', background: coverGradient(title()) }}>
            <CoverImage src={currentProfile()?.cover} eager />
            <Show when={!currentProfile()?.cover}>
              <span class={styles.initial}>{(title()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </div>
          <h1 ref={setHeading} class={styles.title}>{currentProfile()?.title || title()}</h1>
          <ArtistLinks class={styles.artistLink} music={{ artist: currentProfile()?.artist || artistName(), view: view(), artistId: catalogTracks()?.album?.album_artist_id ?? undefined }} />
          <span class={styles.meta}>
            <Show when={currentProfile()?.year}>{currentProfile()!.year}</Show>
            <Show when={currentProfile()?.year && tracklist().length > 0}> · </Show>
            <Show when={tracklist().length > 0}>{trackCount(tracklist().length)}</Show>
          </span>
          <div class={styles.actions}>
            <Show when={state.autoMode.active} fallback={
            <button class={styles.btnPrimary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={playAll}>
              <PlayIcon size={16} />
              {t('album.play')}
            </button>
            }>
              <CollectionActions title={title()} auto buttonClass={styles.btnPrimary}
                tracks={view() === 'library' ? libraryTrackList() : undefined}
                items={view() === 'library' ? undefined : tracklist()} />
            </Show>
            <Show when={!state.autoMode.active}>
              <button class={styles.btnSecondary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={shuffle}>
                <ShuffleIcon size={16} />
                {t('album.shuffle')}
              </button>
            </Show>
          </div>
        </div>

        <Show when={showToggle()}>
          <div class={styles.toggleTabs}>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'discover' }}
              type="button"
              onClick={() => switchView('discover')}
            >
              {t('album.discover')}
            </button>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'library' }}
              type="button"
              onClick={() => switchView('library')}
            >
              {t('album.library')} ({libraryTrackList().length})
            </button>
          </div>
        </Show>
        </header>

        <Show
          when={view() === 'discover' && profile.loading && !currentProfile()}
          fallback={
            <Show
              when={view() === 'library' || currentProfile()}
              fallback={<EmptyState tone={profileError() ? 'danger' : undefined}>{profileError() ? t('common.loadFailed') : t('album.noTracklist')} <Show when={profileError()}><Button variant="secondary" onClick={() => void retryProfile()}>{t('common.retry')}</Button></Show></EmptyState>}
            >
              <Show when={view() === 'discover'} fallback={<Show when={!catalogTracks.loading && !state.loading} fallback={<SkeletonRows />}><LibraryView tracks={libraryTrackList()} context={albumContext('library')} /></Show>}>
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
