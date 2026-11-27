import { CollectionToolbar } from '../components/CollectionToolbar';
import { createCollectionSearch, type CollectionSearchState } from '../components/CollectionSearch';
import { EntityHero, EntityMenuCover } from '../components/EntityHero';
import { openSavedEntityMenu } from '../components/savedEntityActions';
import { CollectionControl, EntityBookmarkButton } from '../components/CollectionControl';
import Button from '../components/Button';
import { Control } from '../design/Control';
import { CollectionActions } from '../components/CollectionActions';
import { blockedByPodcast, firstPlayable, startDjFromCatalog, startDjFromTracks } from '../lib/djStart';
import { openActionMenu } from '../components/ActionMenu';
import { PlayIcon, RadioIcon, menuIcons } from '../components/icons';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { CoverImage } from '../components/CoverImage';
import { MusicLink } from '../components/MusicLinks';
import { createEffect, createMemo, createResource, createSignal, on, Show, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { musicLibrary, isPlayingItem, state } from '../stores';
import { player } from '../stores/player';
import { api } from '../lib/api';
import { hasCoverArt, trackCoverUrl } from '../lib/media';
import { createCatalogDownload } from '../lib/catalogDownload';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { isPodcastTrack } from '../lib/track';
import { artistKey, artistPath, decodeArtistName, parseViewParams } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumSummary, ArtistProfile, CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { useCatalogCollection, playCatalogItem, cancelCatalogResolve, catalogReleaseEvidence } from '../lib/catalogItem';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Artist.module.css';
import hero from '../components/EntityHero.module.css';
import { coverGradient } from '../lib/cover';
import { SkeletonCards, SkeletonHeading, SkeletonRegion, SkeletonRows, SkeletonToolbar } from '../design/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { ArtistDiscoveryView, fansLabel } from '../components/ArtistDiscoveryView';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { EntityTrackList } from '../components/EntityTrackList';
import { tabRoot } from '../lib/tabMemory';

type ViewMode = 'discover' | 'library';

/** What the engine answered about the artist's songs in the library. A failed
 * read is kept apart from an empty one: only the second means "not owned". */
type Membership = { ok: true; trackIds: string[] } | { ok: false };

/** Artist detail page with discover/library toggle.
 * Reached by tapping an artist name, badge, or card anywhere in the app. */
export default function Artist() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const name = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));

  let aborter: AbortController | undefined;

  const fetchProfile = async (artistName: string, deezerId?: string): Promise<ArtistProfile | null> => {
    aborter?.abort();
    aborter = new AbortController();
    try {
      return await api.getArtistProfile(artistName, deezerId, aborter.signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  };

  const [profileError, setProfileError] = createSignal(false);
  // Compared by value: switching Discover / My library rewrites the query
  // string, and a fresh object each time fetched the profile again and blanked
  // the page under the user's tap.
  const profileKey = createMemo(() => ({ n: name(), id: viewParams().deezerId }), undefined,
    { equals: (a, b) => a.n === b.n && a.id === b.id });
  const [profile, { refetch: retryProfile }] = createResource(
    profileKey,
    async (args) => {
      setProfileError(false);
      try { return await fetchProfile(args.n, args.id); }
      catch { setProfileError(true); return null; }
    },
  );

  const currentProfile = () => profile.loading ? null : profile();

  let disposed = false;
  let actionEpoch = 0;
  // Each busy flag belongs to the action that set it, so a later action that
  // makes an earlier one stale does not leave the earlier button disabled.
  let radioOwner = 0;
  let djOwner = 0;

  onCleanup(() => {
    disposed = true;
    actionEpoch++;
    aborter?.abort();
    cancelCatalogResolve();
  });

  // Who performs on what is the engine's answer (`track_artists`), and when the
  // link carried a catalog id we take it: matching the display string here made
  // "Björk & Rosalía" a third artist and hid the duet from both of them.
  //
  // The fallback is not debt. An artist name is also reachable from a song row
  // and from a Deezer result, neither of which has an id to carry, so the old
  // comparison stays as the answer for names that arrived without one. A link
  // with an id never falls back to it, not even when the read fails: the page
  // says so and retries the same id instead.
  const [membership, { refetch: retryMembership }] = createResource(
    () => viewParams().artistId,
    (artistId): Promise<Membership> => api.getLibraryArtist(artistId).then(
      (res) => ({ ok: true, trackIds: res.track_ids ?? [] }),
      () => ({ ok: false }),
    ),
  );
  // Solid retains the previous result when a name-only link disables this
  // resource; that previous artist's error must not hide the current tracks.
  const membershipFailed = () => !!viewParams().artistId && !membership.loading && membership()?.ok === false;

  const libraryTrackList = createMemo<Track[]>(() => {
    if (viewParams().artistId) {
      const read = membership.loading ? undefined : membership();
      return read?.ok ? tracksByIds(read.trackIds) : [];
    }
    const n = artistKey(name());
    if (!n) return [];
    return musicLibrary().filter(
      (t) => artistKey(t.artist) === n || artistKey(t.album_artist) === n
        || t.artists?.some((artist) => artistKey(artist) === n),
    );
  });

  const topTracks = createMemo<CatalogItem[]>(() => currentProfile()?.top_tracks ?? []);
  const albums = createMemo(() => currentProfile()?.albums ?? []);
  const singlesEps = createMemo(() => currentProfile()?.singles_eps ?? []);
  const latestRelease = createMemo(() => currentProfile()?.latest_release ?? null);
  const related = createMemo(() => currentProfile()?.related_artists ?? []);
  const candidates = createMemo(() => currentProfile()?.candidates ?? []);
  const [radioBusy, setRadioBusy] = createSignal(false);
  const [djBusy, setDjBusy] = createSignal(false);
  // A library link (it carries the artist's catalog id) keeps its library tab
  // while the read is pending or after it failed; only an answered empty read
  // says the artist is no longer owned.
  const inLibrary = createMemo(() => {
    if (viewParams().artistId) {
      if (membership.loading || membershipFailed()) return true;
      const read = membership();
      return !!read?.ok && read.trackIds.length > 0;
    }
    return currentProfile()?.in_library ?? libraryTrackList().length > 0;
  });

  const showToggle = createMemo(() => inLibrary() || viewParams().view === 'library');

  createEffect(
    on(
      () => JSON.stringify([name(), viewParams().deezerId ?? '']),
      () => {
        actionEpoch++;
        radioOwner = 0;
        djOwner = 0;
        setRadioBusy(false);
        setDjBusy(false);
      },
      { defer: true },
    ),
  );
  const view = () => viewParams().view;

  /** The catalogue picture, or the artwork of a song the user owns when the
   * catalogue has none or could not be reached. */
  const localCover = createMemo(() => {
    const track = libraryTrackList().find((tr) => hasCoverArt(tr));
    return track ? trackCoverUrl(track) : undefined;
  });
  const cover = () => currentProfile()?.metadata?.picture || localCover();

  /** This artist as a context, leading back to the tab it was played from. */
  const artistContext = (mode: ViewMode = view()): PlaybackContextDescriptor => ({
    id: `artist:${name()}`,
    kind: 'artist',
    label: name(),
    cover: cover(),
    destination: artistPath(name(), {
      view: mode,
      // The artist the page settled on, when the link itself named none.
      deezerId: viewParams().deezerId ?? (currentProfile()?.deezer_id || undefined),
      artistId: mode === 'library' ? viewParams().artistId : undefined,
    }),
  });

  const playAll = () => {
    const context = artistContext();
    if (player().autoMode.active) {
      // An artist is one source for the DJ, never a list of requests.
      if (view() === 'library') void player().actions.startDjSelection(libraryTrackList(), name());
      else void useCatalogCollection(topTracks(), name(), 'start');
      return;
    }
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) player().actions.playFrom(tracks, 0, { context });
    } else {
      const items = topTracks();
      if (items.length === 0) return;
      void playCatalogItem(items[0], items, context);
    }
  };

  const shuffle = () => {
    const context = artistContext();
    if (player().autoMode.active) {
      if (view() === 'library') void player().actions.startDjSelection(libraryTrackList(), name());
      else void useCatalogCollection(topTracks(), name(), 'start');
      return;
    }
    if (view() === 'library') {
      player().actions.playShuffled(libraryTrackList(), context);
    } else {
      const items = topTracks();
      if (items.length === 0) return;
      const order = shuffled(items);
      void playCatalogItem(order[0], order, context);
    }
  };

  const startArtistRadio = async () => {
    if (radioBusy()) return;
    const token = ++actionEpoch;
    const isCurrent = () => !disposed && token === actionEpoch;
    radioOwner = token;
    setRadioBusy(true);
    try {
      if (view() === 'library') {
        const seed = libraryTrackList()[0];
        if (!seed) return;
        await player().actions.startRadio(seed);
        return;
      }
      const candidates = topTracks().slice(0, 10);
      if (candidates.length === 0) return;
      const found = await firstPlayable(candidates, isCurrent);
      if (!isCurrent()) return;
      if (!found) {
        toast.error(t('search.noPreview'));
        return;
      }
      await player().actions.startRadio(found.track);
    } catch {
      if (isCurrent()) toast.error(t('search.noPreview'));
    } finally {
      if (!disposed && radioOwner === token) setRadioBusy(false);
    }
  };

  const podcastPlaying = () => Boolean(player().playback.currentTrack && isPodcastTrack(player().playback.currentTrack!));

  const startArtistDj = async () => {
    if (djBusy() || blockedByPodcast()) return;
    if (view() === 'library') {
      startDjFromTracks(libraryTrackList(), name());
      return;
    }
    const token = ++actionEpoch;
    const isCurrent = () => !disposed && token === actionEpoch;
    djOwner = token;
    setDjBusy(true);
    try {
      await startDjFromCatalog(topTracks(), name(), isCurrent);
    } finally {
      if (!disposed && djOwner === token) setDjBusy(false);
    }
  };

  const { saving, saveItem } = createCatalogDownload(catalogReleaseEvidence);

  /** Other artists the catalogue matched for this name, in the shared sheet:
   * it owns focus, Escape and the way back, and is never clipped by the page. */
  const chooseCandidate = () => {
    const current = viewParams().deezerId ?? currentProfile()?.deezer_id;
    openActionMenu({
      title: t('artist.notThisArtist'),
      subtitle: name(),
      actions: candidates().map((c) => ({
        icon: <span class={styles.candidateAvatar} style={{ background: coverGradient(c.name) }}><CoverImage src={c.picture} /></span>,
        label: `${c.name} · ${fansLabel(c.nb_fans)}`,
        selected: !!current && c.deezer_id === current,
        onSelect: () => navigate(artistPath(name(), { deezerId: c.deezer_id, view: 'discover' })),
      })),
    });
  };

  const switchView = (mode: ViewMode) => {
    setSearchParams({ view: mode }, { replace: true });
  };

  const back = () => navigateBackOr(
    navigate,
    view() === 'library' ? '/' : (tabRoot('/search') ?? '/search'),
  );
  let openCollectionMenu = () => {};
  const search = createCollectionSearch();
  createEffect(on([profileKey, view, () => viewParams().artistId], search.reset, { defer: true }));
  const canSearch = () => view() === 'library'
    ? !membershipFailed() && libraryTrackList().length > 0
    : topTracks().length > 0;
  const playable = () => view() === 'library' ? libraryTrackList().length > 0 : topTracks().length > 0;
  const radioLabel = () => t(player().autoMode.active ? 'modeChange.startRadio' : 'trackActions.startRadio');

  const entity = () => ({
    kind: 'artist' as const,
    name: name(),
    cover: cover(),
    destination: artistPath(name(), { view: view(), artistId: viewParams().artistId, deezerId: viewParams().deezerId }),
  });

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => view() === 'library' ? !membership.loading : !profile.loading)}
        class={hero.page}
        data-primary-scroll
      >
        <EntityHero name={name()} back={back} backLabel={t('artist.ariaBack')} search={canSearch() ? search.reveal : undefined}
          openMenu={() => openCollectionMenu()}
          corner={<EntityBookmarkButton entity={entity()} />}
          art={<EntityMenuCover name={name()} cover={cover()} round onOpen={() => openCollectionMenu()} />}
          metadata={<>
            <span class={hero.meta}>
              <Show when={currentProfile()?.metadata?.nb_fans}>
                <span>{fansLabel(currentProfile()!.metadata!.nb_fans)}</span>
              </Show>
            </span>
          </>}>
          <div class={hero.toolbar} data-entity-toolbar>
            <Show when={showToggle()} fallback={<span class={hero.context}>{t('artist.discover')}</span>}>
              <EntityViewSelect label={t('entityView.label')} value={view()} onChange={value => switchView(value as ViewMode)}
                options={[
                  { value: 'discover', label: t('artist.discover') },
                  { value: 'library', label: `${t('artist.library')}${membership.loading || membershipFailed() ? '' : ` (${libraryTrackList().length})`}` },
                ]} />
            </Show>
            <div class={hero.primaryActions}>
              <Show when={player().autoMode.active} fallback={
                <button type="button" class={hero.play} aria-label={t('artist.play')} title={t('artist.play')} disabled={!playable()} onClick={playAll}>
                  <PlayIcon size={16} />
                  <span class={hero.primaryLabel}>{t('artist.play')}</span>
                </button>
              }>
                <CollectionActions title={name()} iconOnlyOnMobile buttonClass={hero.play}
                  tracks={view() === 'library' ? libraryTrackList() : undefined}
                  items={view() === 'library' ? undefined : topTracks()} />
              </Show>
              <Control
                class={hero.secondary}
                aria-label={radioLabel()}
                title={radioLabel()}
                disabled={!playable() || radioBusy()}
                aria-busy={radioBusy() || undefined}
                onClick={() => void startArtistRadio()}
              >
                <RadioIcon size={16} />
                <span class={hero.primaryLabel}>{radioLabel()}</span>
              </Control>
            </div>
            <CollectionControl
              compact menuActions={() => [
                ...(!player().autoMode.active ? [
                  { icon: menuIcons.shuffle(), label: t('artist.shuffle'), disabled: !playable(), onSelect: shuffle },
                  { icon: menuIcons.changeSession(), label: t('autoMode.startDj'), disabled: !playable() || djBusy() || podcastPlaying(), onSelect: () => void startArtistDj() },
                ] : []),
                ...(candidates().length ? [{ icon: menuIcons.artist(), label: t('artist.notThisArtist'), onSelect: chooseCandidate }] : []),
              ]}
              onMenuReady={(open) => { openCollectionMenu = open; }}
              entity={entity()}
              deezerId={viewParams().deezerId ?? (currentProfile()?.deezer_id || undefined)} />
          </div>
        </EntityHero>

        <Show
          when={view() === 'discover' && profile.loading && !currentProfile()}
          fallback={
            <Show
              when={view() === 'library' || currentProfile()}
              fallback={<EmptyState tone={profileError() ? 'danger' : undefined}>{profileError() ? t('common.loadFailed') : t('artist.noCatalogData')} <Show when={profileError()}><Button class={hero.retry} variant="secondary" size="sm" onClick={() => void retryProfile()}>{t('common.retry')}</Button></Show></EmptyState>}
            >
              <Show when={view() === 'discover'} fallback={
                <LibraryView search={search} tracks={libraryTrackList()} loading={state.loading || membership.loading}
                  failed={membershipFailed()} onRetry={() => void retryMembership()} context={artistContext('library')} />
              }>
                <DiscoverView
                  search={search}
                  topTracks={topTracks()}
                  albums={albums()}
                  singlesEps={singlesEps()}
                  latestRelease={latestRelease()}
                  related={related()}
                  loading={profile.loading}
                  saving={saving()}
                  onPlayItem={(item, queue) => void playCatalogItem(item, queue, artistContext('discover'))}
                  onSaveItem={saveItem}
                  artistName={name()}
                />
              </Show>
            </Show>
          }
        >
          <SkeletonRegion>
            <div class={`${styles.section} ${styles.topSection}`}>
              <SkeletonToolbar contained />
              <div class={styles.trackList}>
                <SkeletonRows count={5} indexed decorative />
              </div>
            </div>
            <div class={styles.section}>
              <div class={styles.sectionHead}>
                <SkeletonHeading size="h3" />
              </div>
              <SkeletonCards class={styles.albumRail} cardClass={styles.albumCard} layout="rail" lines={2} decorative />
            </div>
          </SkeletonRegion>
        </Show>
      </div>
    </div>
  );
}

function LibraryView(props: { search: CollectionSearchState; tracks: Track[]; loading: boolean; failed: boolean; onRetry: () => void; context: PlaybackContextDescriptor }) {
  return (
    <div class={styles.libraryView}>
      <Show when={!props.failed} fallback={
        <EmptyState tone="danger">{t('common.loadFailed')} <Button class={hero.retry} variant="secondary" size="sm" onClick={() => props.onRetry()}>{t('common.retry')}</Button></EmptyState>
      }>
        <Show when={props.tracks.length > 0} fallback={<Show when={props.loading} fallback={<EmptyState>{t('artist.empty')}</EmptyState>}><SkeletonRegion><SkeletonToolbar /><SkeletonRows count={8} indexed decorative /></SkeletonRegion></Show>}>
          <EntityTrackList search={props.search} tracks={props.tracks} context={props.context} />
        </Show>
      </Show>
    </div>
  );
}

function DiscoverView(props: {
  search: CollectionSearchState;
  topTracks: CatalogItem[];
  albums: AlbumSummary[];
  singlesEps: AlbumSummary[];
  latestRelease: AlbumSummary | null;
  related: Array<{ deezer_id: string; name: string; picture: string; nb_fans: number }>;
  loading: boolean;
  saving: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
  artistName: string;
}) {
  return <ArtistDiscoveryView search={props.search} toolbar={<CollectionToolbar search={props.search} contained />} topTracks={props.topTracks} albums={props.albums} singlesEps={props.singlesEps}
    latestRelease={props.latestRelease} related={props.related} loading={props.loading} artistName={props.artistName}
    renderSong={(item, _index, queue, rank) => <CatalogResultRow item={item} index={rank} active={isPlayingItem(item)}
      saving={props.saving.has(item.id)} onPlay={() => props.onPlayItem(item, queue())} onDownload={() => props.onSaveItem(item)} />}
    renderLink={link => <MusicLink class={link.class} path={link.entity.destination} onMenu={event => void openSavedEntityMenu(link.entity, event)}>{link.children}</MusicLink>} />;
}
