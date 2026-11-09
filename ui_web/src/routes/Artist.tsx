import { createResponsiveTap } from '../lib/responsiveTap';
import { openSavedEntityMenu } from '../components/savedEntityActions';
import { CollectionControl } from '../components/CollectionControl';
import Button from '../components/Button';
import { CollectionActions } from '../components/CollectionActions';
import { openActionMenu } from '../components/ActionMenu';
import { BackIcon, PlayIcon, menuIcons } from '../components/icons';
import { EntityViewSelect } from '../components/EntityViewSelect';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { CoverImage } from '../components/CoverImage';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { MusicLink } from '../components/MusicLinks';
import { createEffect, createMemo, createResource, createSignal, For, on, Show, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { actions, musicLibrary, isPlayingItem, state } from '../stores';
import { api } from '../lib/api';
import { hasCoverArt, trackCoverUrl } from '../lib/media';
import { catalogItemKeys } from '../lib/playbackIdentity';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { artistKey, artistPath, decodeArtistName, parseViewParams, resolveViewMode } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { ArtistProfile, CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { useCatalogCollection, itemArtist, playCatalogItem, cancelCatalogResolve, catalogReleaseEvidence } from '../lib/catalogItem';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Artist.module.css';
import hero from '../components/EntityHero.module.css';
import { coverGradient } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SongRow from '../components/SongRow';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { ArtistDiscoveryView, fansLabel } from '../components/ArtistDiscoveryView';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
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
  const [viewOverride, setViewOverride] = createSignal<ViewMode | null>(null);
  const [saving, setSaving] = createSignal<Set<string>>(new Set());

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

  onCleanup(() => {
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
  const related = createMemo(() => currentProfile()?.related_artists ?? []);
  const candidates = createMemo(() => currentProfile()?.candidates ?? []);
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

  const showToggle = createMemo(() => inLibrary());

  // The router reuses this component when only :name changes, so a tab held in
  // a signal seeded at mount would survive navigation to a different artist —
  // stranding the user on an empty "My library" tab whose toggle is hidden for
  // artists they do not own. The URL is the source of truth; a tap overrides it
  // until the next navigation, and the tab is forced to discover whenever the
  // toggle is not offered, so the view always has a way out.
  createEffect(
    on(
      () => JSON.stringify([name(), viewParams().deezerId ?? '']),
      () => setViewOverride(null),
      { defer: true },
    ),
  );
  const view = createMemo<ViewMode>(() =>
    resolveViewMode({ urlView: viewParams().view, override: viewOverride(), canToggle: showToggle() }),
  );

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
    if (state.autoMode.active) {
      // An artist is one source for the DJ, never a list of requests.
      if (view() === 'library') void actions.startDjSelection(libraryTrackList(), name());
      else void useCatalogCollection(topTracks(), name(), 'start');
      return;
    }
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) actions.playFrom(tracks, 0, { context });
    } else {
      const items = topTracks();
      if (items.length === 0) return;
      void playCatalogItem(items[0], items, context);
    }
  };

  const shuffle = () => {
    const context = artistContext();
    if (state.autoMode.active) {
      if (view() === 'library') void actions.startDjSelection(libraryTrackList(), name());
      else void useCatalogCollection(topTracks(), name(), 'start');
      return;
    }
    if (view() === 'library') {
      actions.playShuffled(libraryTrackList(), context);
    } else {
      const items = topTracks();
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
        identity_keys: catalogItemKeys(item),
        ...catalogReleaseEvidence(item),
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
    setViewOverride(mode);
    setSearchParams({ view: mode }, { replace: true });
  };

  // A page with no way back in history sits on the search it belongs to.
  const back = () => navigateBackOr(navigate, tabRoot('/search') ?? '/search');
  let openCollectionMenu = () => {};
  const coverMenuTap = createResponsiveTap({ onTap: () => openCollectionMenu(), onLongPress: () => openCollectionMenu() });
  const titleMenuTap = createResponsiveTap({ onTap: () => openCollectionMenu(), onLongPress: () => openCollectionMenu() });
  const headerContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openCollectionMenu();
  };
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({ title: name, back, backLabel: () => t('artist.ariaBack'), heading });

  const playable = () => view() === 'library' ? libraryTrackList().length > 0 : topTracks().length > 0;

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => !profile.loading)}
        class={hero.page}
        data-primary-scroll
      >
        <header class={hero.header}>
        <Show when={desktopShell()}>
          <button class={hero.back} type="button" aria-label={t('artist.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>

        <div class={hero.hero}>
          <button type="button" classList={{ [hero.art]: true, [hero.round]: true }} data-testid="collection-header-cover"
            aria-label={`${t('savedEntities.options')}: ${name()}`} aria-haspopup="dialog"
            {...coverMenuTap} onContextMenu={headerContextMenu} style={{ background: coverGradient(name()) }}>
            <CoverImage src={cover()} eager />
            <Show when={!cover()}>
              <span class={hero.initial} aria-hidden="true">{(name()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </button>
          <div class={hero.identity}>
            <h1 ref={setHeading} class={hero.title}><button type="button" class={hero.titleButton}
              data-testid="collection-header-name" aria-haspopup="dialog" title={t('savedEntities.options')}
              {...titleMenuTap} onContextMenu={headerContextMenu}>{name()}</button></h1>
            <span class={hero.meta}>
              <Show when={currentProfile()?.metadata?.nb_fans}>
                <span>{fansLabel(currentProfile()!.metadata!.nb_fans)}</span>
              </Show>
            </span>
          </div>
          <div class={hero.toolbar} data-entity-toolbar>
            <Show when={showToggle()} fallback={<span class={hero.context}>{t('artist.discover')}</span>}>
              <EntityViewSelect label={t('entityView.label')} value={view()} onChange={value => switchView(value as ViewMode)}
                options={[
                  { value: 'discover', label: t('artist.discover') },
                  { value: 'library', label: `${t('artist.library')}${membership.loading || membershipFailed() ? '' : ` (${libraryTrackList().length})`}` },
                ]} />
            </Show>
            <Show when={state.autoMode.active} fallback={
              <button type="button" class={hero.play} aria-label={t('artist.play')} title={t('artist.play')} disabled={!playable()} onClick={playAll}>
                <PlayIcon size={16} />
                <span class={hero.primaryLabel}>{t('artist.play')}</span>
              </button>
            }>
              <CollectionActions title={name()} auto iconOnlyOnMobile buttonClass={hero.play}
                tracks={view() === 'library' ? libraryTrackList() : undefined}
                items={view() === 'library' ? undefined : topTracks()} />
            </Show>
            <CollectionControl
              compact menuActions={() => [
                ...(!state.autoMode.active ? [{ icon: menuIcons.shuffle(), label: t('artist.shuffle'), disabled: !playable(), onSelect: shuffle }] : []),
                ...(candidates().length ? [{ icon: menuIcons.artist(), label: t('artist.notThisArtist'), onSelect: chooseCandidate }] : []),
              ]}
              onMenuReady={(open) => { openCollectionMenu = open; }}
              entity={{ kind: 'artist', name: name(), cover: cover(), destination: artistPath(name(), { view: view(), artistId: viewParams().artistId, deezerId: viewParams().deezerId }) }}
              deezerId={viewParams().deezerId ?? (currentProfile()?.deezer_id || undefined)} />
          </div>
        </div>

        </header>

        <Show
          when={view() === 'discover' && profile.loading && !currentProfile()}
          fallback={
            <Show
              when={view() === 'library' || currentProfile()}
              fallback={<EmptyState tone={profileError() ? 'danger' : undefined}>{profileError() ? t('common.loadFailed') : t('artist.noCatalogData')} <Show when={profileError()}><Button class={hero.retry} variant="secondary" size="sm" onClick={() => void retryProfile()}>{t('common.retry')}</Button></Show></EmptyState>}
            >
              <Show when={view() === 'discover'} fallback={
                <LibraryView tracks={libraryTrackList()} loading={state.loading || membership.loading}
                  failed={membershipFailed()} onRetry={() => void retryMembership()} context={artistContext('library')} />
              }>
                <DiscoverView
                  topTracks={topTracks()}
                  albums={albums()}
                  singlesEps={singlesEps()}
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
          <SkeletonRows count={6} />
        </Show>
      </div>
    </div>
  );
}

function LibraryView(props: { tracks: Track[]; loading: boolean; failed: boolean; onRetry: () => void; context: PlaybackContextDescriptor }) {
  return (
    <div class={styles.libraryView}>
      <Show when={!props.failed} fallback={
        <EmptyState tone="danger">{t('common.loadFailed')} <Button class={hero.retry} variant="secondary" size="sm" onClick={() => props.onRetry()}>{t('common.retry')}</Button></EmptyState>
      }>
        <Show when={props.tracks.length > 0} fallback={<Show when={props.loading} fallback={<EmptyState>{t('artist.empty')}</EmptyState>}><SkeletonRows /></Show>}>
          <TrackListLite tracks={props.tracks} context={props.context} />
        </Show>
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
  topTracks: CatalogItem[];
  albums: Array<{ deezer_id: string; title: string; cover: string; year?: number | null; track_count?: number }>;
  singlesEps: Array<{ deezer_id: string; title: string; cover: string; year?: number | null; track_count?: number }>;
  related: Array<{ deezer_id: string; name: string; picture: string; nb_fans: number }>;
  loading: boolean;
  saving: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
  artistName: string;
}) {
  return <ArtistDiscoveryView topTracks={props.topTracks} albums={props.albums} singlesEps={props.singlesEps}
    related={props.related} loading={props.loading} artistName={props.artistName}
    renderSong={(item, index, queue) => <CatalogResultRow item={item} index={index} active={isPlayingItem(item)}
      saving={props.saving.has(item.id)} onPlay={() => props.onPlayItem(item, queue)} onDownload={() => props.onSaveItem(item)} />}
    renderLink={link => <MusicLink class={link.class} path={link.entity.destination} onMenu={event => void openSavedEntityMenu(link.entity, event)}>{link.children}</MusicLink>} />;
}
