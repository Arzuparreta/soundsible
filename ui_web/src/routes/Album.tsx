import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { actions, musicLibrary, isPlayingItem, isPlayingTrack, isSavedItem } from '../stores';
import { api } from '../lib/api';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { shuffled } from '../lib/shuffle';
import { toast } from '../lib/toast';
import { artistKey, artistPath, decodeArtistName, parseViewParams, resolveViewMode } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumProfile, CatalogItem, Track } from '../types/music';
import { Spinner } from '../components/Spinner';
import { itemArtist, itemBusy, playCatalogItem, cancelCatalogResolve } from '../lib/catalogItem';
import { savedFromCatalogItem, savedFromTrack } from '../lib/saved';
import { FavouriteButton } from '../components/FavouriteButton';
import { CollectionButton } from '../components/CollectionButton';
import styles from './Album.module.css';
import { coverGradient, coverStyle } from '../lib/cover';
import { formatDuration } from '../lib/format';
import { SkeletonRows } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

type ViewMode = 'discover' | 'library';

/** Album detail page with discover/library toggle.
 * Reached by tapping an album card from the artist page or search. */
export default function Album() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const title = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));
  const artistName = createMemo(() => (searchParams as Record<string, string | undefined>).artist || '');
  const [viewOverride, setViewOverride] = createSignal<ViewMode | null>(null);
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());

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

  const [profile] = createResource(
    () => ({ t: title(), a: artistName(), id: viewParams().deezerId }),
    (args) => fetchAlbum(args.t, args.a, args.id),
  );

  onCleanup(() => {
    aborter?.abort();
    cancelCatalogResolve();
  });

  const libraryTrackList = createMemo<Track[]>(() => {
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

  const tracklist = createMemo<CatalogItem[]>(() => profile()?.tracklist ?? []);
  const inLibrary = createMemo(() => profile()?.in_library ?? libraryTrackList().length > 0);
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

  // Named apart from the shared `coverStyle` helper: this is the page hero,
  // which fills edge to edge with no gradient underlay.
  const heroCoverStyle = (): JSX.CSSProperties => {
    const cover = profile()?.cover;
    if (cover) return { background: `url("${cover}") center / cover no-repeat` };
    return { background: coverGradient(title()) };
  };

  const playAll = () => {
    const context = { id: `album:${title()}`, kind: 'album' as const, label: title() };
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
    const context = { id: `album:${title()}`, kind: 'album' as const, label: title() };
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
        setSaved((s) => new Set(s).add(item.id));
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

  const goArtist = () => {
    const a = profile()?.artist || artistName();
    if (a) navigate(artistPath(a, { view: 'discover' }));
  };

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label={t('album.ariaBack')} onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class={styles.hero}>
          <div class={styles.cover} style={heroCoverStyle()}>
            <Show when={!profile()?.cover}>
              <span class={styles.initial}>{(title()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </div>
          <h1 class={styles.title}>{profile()?.title || title()}</h1>
          <button class={styles.artistLink} type="button" onClick={goArtist}>
            {profile()?.artist || artistName()}
          </button>
          <span class={styles.meta}>
            <Show when={profile()?.year}>{profile()!.year}</Show>
            <Show when={profile()?.year && tracklist().length > 0}> · </Show>
            <Show when={tracklist().length > 0}>{trackCount(tracklist().length)}</Show>
          </span>
          <div class={styles.actions}>
            <button class={styles.btnPrimary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={playAll}>
              {t('album.play')}
            </button>
            <button class={styles.btnSecondary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={shuffle}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style={{ 'margin-right': '6px' }}>
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
              {t('album.shuffle')}
            </button>
          </div>
        </div>

        <Show when={showToggle()}>
          <div class={styles.toggleTabs}>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'discover' }}
              type="button"
              onClick={() => setViewOverride('discover')}
            >
              {t('album.discover')}
            </button>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'library' }}
              type="button"
              onClick={() => setViewOverride('library')}
            >
              {t('album.library')} ({libraryTrackList().length})
            </button>
          </div>
        </Show>
      </header>

      <Show
        when={profile.loading && !profile()}
        fallback={
          <Show
            when={profile()}
            fallback={<EmptyState>{t('album.noTracklist')}</EmptyState>}
          >
            <Show when={view() === 'discover'} fallback={<LibraryView tracks={libraryTrackList()} contextLabel={title()} />}>
              <DiscoverView
                tracklist={tracklist()}
                saving={saving()}
                saved={saved()}
                onPlayItem={(item, queue) => void playCatalogItem(item, queue, {
                  id: `album:${title()}`,
                  kind: 'album',
                  label: title(),
                })}
                onSaveItem={saveItem}
              />
            </Show>
          </Show>
        }
      >
        <SkeletonRows count={8} />
      </Show>
    </div>
  );
}

function LibraryView(props: { tracks: Track[]; contextLabel: string }) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracks.length > 0} fallback={<EmptyState>{t('album.empty')}</EmptyState>}>
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
          <div
            class={styles.trackRow}
            data-now-playing={isPlayingTrack(track) ? '' : undefined}
            onClick={() => actions.playFrom(props.tracks, i(), {
              context: { id: `album:${props.contextLabel}`, kind: 'album', label: props.contextLabel },
            })}
          >
            <span class={styles.trackIndex}>{i() + 1}</span>
            <span
              class={styles.trackCover}
              style={coverStyle(track.id, track.source === 'preview' ? track.cover : coverUrl(track.id))}
            />
            <span class={styles.trackMeta}>
              <span class={styles.trackTitle}>{track.title}</span>
            </span>
            <span class={styles.trackDuration}>{formatDuration(track.duration)}</span>
            <FavouriteButton favourite={savedFromTrack(track)} compact />
            <CollectionButton entry={savedFromTrack(track)} compact hideOwned />
          </div>
        )}
      </For>
    </div>
  );
}

function DiscoverView(props: {
  tracklist: CatalogItem[];
  saving: Set<string>;
  saved: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
}) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracklist.length > 0} fallback={<EmptyState>{t('album.noTracklist')}</EmptyState>}>
        <div class={styles.trackList}>
          <For each={props.tracklist}>
            {(item, i) => (
              <div
                class={styles.trackRow}
                data-now-playing={isPlayingItem(item) ? '' : undefined}
                aria-busy={itemBusy(item)}
                onClick={() => props.onPlayItem(item, props.tracklist)}
              >
                <span class={styles.trackIndex}>{i() + 1}</span>
                <span class={styles.trackCover} style={coverStyle(item.id, item.cover)}>
                  <Show when={itemBusy(item)}>
                    <span class={styles.trackCoverBusy}>
                      <Spinner size={16} />
                    </span>
                  </Show>
                </span>
                <span class={styles.trackMeta}>
                  <span class={styles.trackTitle}>{item.title}</span>
                  <Show when={item.artist && item.artist !== (item.subtitle || '')}>
                    <span class={styles.trackArtist}>{itemArtist(item)}</span>
                  </Show>
                </span>
                <span class={styles.trackDuration}>{formatDuration(item.duration)}</span>
                {/* The heart only over songs already in the library; ＋ is what puts one
                  * there, and the arrow that replaces it gives it a file. */}
                <Show when={isSavedItem(item)}>
                  <FavouriteButton favourite={savedFromCatalogItem(item)} compact />
                </Show>
                <Show when={item.type === 'track'}>
                  <CollectionButton
                    entry={savedFromCatalogItem(item)}
                    compact
                    busy={props.saving.has(item.id)}
                    onDownload={() => props.onSaveItem(item)}
                  />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

