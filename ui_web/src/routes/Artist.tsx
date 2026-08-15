import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { actions, musicLibrary, isPlayingItem } from '../stores';
import { api } from '../lib/api';
import { coverUrl } from '../lib/media';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { artistKey, artistPath, albumPath, decodeArtistName, parseViewParams, resolveViewMode } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { ArtistProfile, CatalogItem, Track } from '../types/music';
import { itemArtist, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import { tracksByIds } from '../lib/catalogTracks';
import styles from './Artist.module.css';
import { coverGradient, coverStyle } from '../lib/cover';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import SongRow from '../components/SongRow';
import { CatalogResultRow } from '../components/CatalogResultRow';
import { navigateBackOr, registerPrimaryScroll } from '../lib/scrollHistory';
import { createResponsiveTap } from '../lib/responsiveTap';

type ViewMode = 'discover' | 'library';

function formatFans(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** Artist detail page with discover/library toggle.
 * Reached by tapping an artist name, badge, or card anywhere in the app. */
export default function Artist() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const name = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));
  const [viewOverride, setViewOverride] = createSignal<ViewMode | null>(null);
  const [disambigOpen, setDisambigOpen] = createSignal(false);
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

  const [profile] = createResource(
    () => ({ n: name(), id: viewParams().deezerId }),
    (args) => fetchProfile(args.n, args.id),
  );

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
  // comparison stays as the answer for names that arrived without one.
  const [catalogTracks] = createResource(
    () => viewParams().artistId,
    (artistId) => api.getLibraryArtist(artistId).then((res) => res.track_ids ?? []).catch(() => []),
  );

  const libraryTrackList = createMemo<Track[]>(() => {
    if (viewParams().artistId) return tracksByIds(catalogTracks() ?? []);
    const n = artistKey(name());
    if (!n) return [];
    return musicLibrary().filter(
      (t) => artistKey(t.artist) === n || artistKey(t.album_artist) === n,
    );
  });

  const topTracks = createMemo<CatalogItem[]>(() => profile()?.top_tracks ?? []);
  const albums = createMemo(() => profile()?.albums ?? []);
  const singlesEps = createMemo(() => profile()?.singles_eps ?? []);
  const related = createMemo(() => profile()?.related_artists ?? []);
  const candidates = createMemo(() => profile()?.candidates ?? []);
  const inLibrary = createMemo(() => profile()?.in_library ?? libraryTrackList().length > 0);

  const avatar = (): JSX.CSSProperties => {
    const pic = profile()?.metadata?.picture;
    if (pic) return { background: `url("${pic}") center / cover no-repeat` };
    return { background: coverGradient(name()) };
  };

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

  const playAll = () => {
    const context = { id: `artist:${name()}`, kind: 'artist' as const, label: name() };
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
    const context = { id: `artist:${name()}`, kind: 'artist' as const, label: name() };
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

  const relatedBg = (picture: string, seed: string): JSX.CSSProperties => ({
    background: picture
      ? `url("${picture}") center / cover no-repeat`
      : coverGradient(seed),
  });

  const handleAlbumClick = (album: { deezer_id: string; title: string }) => {
    navigate(albumPath(album.title, name(), { deezerId: album.deezer_id, view: 'discover' }));
  };

  const handleRelatedClick = (artist: { deezer_id: string; name: string }) => {
    navigate(artistPath(artist.name, { deezerId: artist.deezer_id, view: 'discover' }));
  };

  const handleCandidateClick = (c: { deezer_id: string; name: string }) => {
    setDisambigOpen(false);
    navigate(artistPath(name(), { deezerId: c.deezer_id, view: 'discover' }));
  };

  const switchView = (mode: ViewMode) => {
    setViewOverride(mode);
    setSearchParams({ view: mode }, { replace: true });
  };

  return (
    <div class="view">
      <div
        ref={(element) => registerPrimaryScroll(element, () => !profile.loading)}
        class={styles.pageScroll}
        data-primary-scroll
      >
        <header class={styles.header}>
        <button class={styles.back} type="button" aria-label={t('artist.ariaBack')} onClick={() => navigateBackOr(navigate, '/search')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class={styles.hero}>
          <div class={styles.avatar} style={avatar()}>
            <Show when={!profile()?.metadata?.picture}>
              <span class={styles.initial}>{(name()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </div>
          <div class={styles.titleRow}>
            <h1 class={styles.title}>{name()}</h1>
            <Show when={candidates().length > 0}>
              <div class={styles.disambigWrap}>
                <button
                  class={styles.chevronBtn}
                  type="button"
                  aria-label={t('artist.notThisArtist')}
                  title={t('artist.notThisArtist')}
                  onClick={() => setDisambigOpen((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <Show when={disambigOpen()}>
                  <div class={styles.disambigDropdown}>
                    <For each={candidates()}>
                      {(c) => (
                        <button class={styles.disambigItem} type="button" onClick={() => handleCandidateClick(c)}>
                          <span class={styles.disambigAvatar} style={relatedBg(c.picture, c.name)} />
                          <span class={styles.disambigMeta}>
                            <span class={styles.disambigName}>{c.name}</span>
                            <span class={styles.disambigFans}>{formatFans(c.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <span class={styles.count}>
            <Show when={profile()?.metadata?.nb_fans}>
              {formatFans(profile()!.metadata!.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}
            </Show>
            <Show when={profile()?.metadata?.nb_fans && inLibrary()}>
              {' · '}
            </Show>
            <Show when={inLibrary()}>
              {t('artist.inLibraryCount').replace('{n}', String(libraryTrackList().length))}
            </Show>
          </span>
          <div class={styles.actions}>
            <Button onClick={playAll} disabled={view() === 'library' ? libraryTrackList().length === 0 : topTracks().length === 0}>
              {t('artist.play')}
            </Button>
            <Button variant="secondary" onClick={shuffle} disabled={view() === 'library' ? libraryTrackList().length === 0 : topTracks().length === 0}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style={{ 'margin-right': '6px' }}>
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
              {t('artist.shuffle')}
            </Button>
          </div>
        </div>

        <Show when={showToggle()}>
          <div class={styles.toggleTabs}>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'discover' }}
              type="button"
              onClick={() => switchView('discover')}
            >
              {t('artist.discover')}
            </button>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'library' }}
              type="button"
              onClick={() => switchView('library')}
            >
              {t('artist.library')} ({libraryTrackList().length})
            </button>
          </div>
        </Show>
        </header>

        <Show
          when={profile.loading && !profile()}
          fallback={
            <Show
              when={profile()}
              fallback={<EmptyState>{t('artist.noCatalogData')}</EmptyState>}
            >
              <Show when={view() === 'discover'} fallback={<LibraryView tracks={libraryTrackList()} loading={false} contextLabel={name()} />}>
                <DiscoverView
                  topTracks={topTracks()}
                  albums={albums()}
                  singlesEps={singlesEps()}
                  related={related()}
                  loading={profile.loading}
                  saving={saving()}
                  onPlayItem={(item, queue) => void playCatalogItem(item, queue, {
                    id: `artist:${name()}`,
                    kind: 'artist',
                    label: name(),
                  })}
                  onSaveItem={saveItem}
                  onAlbumClick={handleAlbumClick}
                  onRelatedClick={handleRelatedClick}
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

function Button(props: { onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary'; children: JSX.Element }) {
  return (
    <button
      classList={{
        [styles.btnPrimary]: props.variant !== 'secondary',
        [styles.btnSecondary]: props.variant === 'secondary',
      }}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function LibraryView(props: { tracks: Track[]; loading: boolean; contextLabel: string }) {
  return (
    <div class={styles.libraryView}>
      <Show when={props.tracks.length > 0} fallback={<EmptyState>{t('artist.empty')}</EmptyState>}>
        <TrackListLite tracks={props.tracks} contextLabel={props.contextLabel} />
      </Show>
    </div>
  );
}

function TrackListLite(props: { tracks: Track[]; contextLabel: string }) {
  return (
    <div class={styles.trackList}>
      <For each={props.tracks}>
        {(track, i) => (
          <SongRow
            track={track}
            index={i() + 1}
            cover={track.source === 'preview' ? track.cover : coverUrl(track.id, 'thumb')}
            onPlay={() => actions.playFrom(props.tracks, i(), {
              context: { id: `artist:${props.contextLabel}`, kind: 'artist', label: props.contextLabel },
            })}
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
  onAlbumClick: (album: { deezer_id: string; title: string }) => void;
  onRelatedClick: (artist: { deezer_id: string; name: string }) => void;
}) {
  return (
    <div class={styles.discoverView}>
      <Show when={props.topTracks.length > 0} fallback={<Show when={!props.loading}><p class={styles.sectionEmpty}>{t('artist.noTopTracks')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.topTracks')}</h2>
          <div class={styles.trackList}>
            <For each={props.topTracks.slice(0, 10)}>
              {(item, i) => (
                <CatalogResultRow
                  item={item}
                  index={i() + 1}
                  active={isPlayingItem(item)}
                  saving={props.saving.has(item.id)}
                  onPlay={() => props.onPlayItem(item, props.topTracks.slice(0, 10))}
                  onDownload={() => props.onSaveItem(item)}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.albums.length > 0} fallback={<Show when={!props.loading && props.topTracks.length > 0}><p class={styles.sectionEmpty}>{t('artist.noAlbums')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.albums')}</h2>
          <div class={styles.albumRail} data-horizontal-scroll>
            <For each={props.albums}>
              {(al) => {
                const tap = createResponsiveTap({ onTap: () => props.onAlbumClick(al) });
                return (
                  <button class={styles.albumCard} type="button" data-pressable {...tap}>
                    <span class={styles.albumCover} style={coverStyle(al.title, al.cover)} />
                    <span class={styles.albumName}>{al.title}</span>
                    <span class={styles.albumCount}>{al.year ? `${al.year}` : ''}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.singlesEps.length > 0}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.singlesEps')}</h2>
          <div class={styles.albumRail} data-horizontal-scroll>
            <For each={props.singlesEps}>
              {(al) => {
                const tap = createResponsiveTap({ onTap: () => props.onAlbumClick(al) });
                return (
                  <button class={styles.albumCard} type="button" data-pressable {...tap}>
                    <span class={styles.albumCover} style={coverStyle(al.title, al.cover)} />
                    <span class={styles.albumName}>{al.title}</span>
                    <span class={styles.albumCount}>{al.year ? `${al.year}` : ''}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.related.length > 0} fallback={<Show when={!props.loading && props.topTracks.length === 0 && props.albums.length === 0}><p class={styles.sectionEmpty}>{t('artist.noRelated')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.related')}</h2>
          <div class={styles.albumRail} data-horizontal-scroll>
            <For each={props.related}>
              {(artist) => {
                const tap = createResponsiveTap({ onTap: () => props.onRelatedClick(artist) });
                return (
                  <button class={styles.albumCard} type="button" data-pressable {...tap}>
                    <span classList={{ [styles.albumCover]: true, [styles.roundCover]: true }} style={coverStyle(artist.name, artist.picture)} />
                    <span class={styles.albumName}>{artist.name}</span>
                    <span class={styles.albumCount}>{formatFans(artist.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}
