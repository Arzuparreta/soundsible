import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { Control } from '../../design/Control';
import { api } from '../../lib/api';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { libraryContext } from '../../lib/playbackContext';
import { playlistNames } from '../../lib/playlistOrder';
import { actions, isPlayingTrack, musicLibrary, state } from '../../stores';
import { TvCard } from '../components/TvCard';
import { TvTrackRow } from '../components/TvTrackRow';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { albumTvHash, playlistTvHash } from '../nav/router';
import {
  libraryAlbums,
  libraryAlbumsHasMore,
  libraryAlbumsNextOffset,
  libraryAlbumsRevision,
  libraryTab,
  setLibraryAlbums,
  setLibraryAlbumsHasMore,
  setLibraryAlbumsNextOffset,
  setLibraryAlbumsRevision,
  setLibraryTab,
  type TvLibraryTab,
} from '../state';
import {
  albumCoverUrl,
  buildTrackIndex,
  deriveAlbumsFromTracks,
  playlistCoverUrl,
} from '../tvLibraryHelpers';
import styles from '../styles/tv.module.css';

interface TvLibraryProps {
  onNavigate: (hash: string) => void;
}

export const TV_LIBRARY_ALBUM_PAGE_SIZE = 120;

export function TvLibrary(props: TvLibraryProps) {
  const focus = useTvFocus();
  const [loadingMoreAlbums, setLoadingMoreAlbums] = createSignal(false);

  const trackIndex = createMemo(() => buildTrackIndex(musicLibrary(), state.library));
  const savedPlaylists = createMemo(() =>
    playlistNames(state.playlists, state.librarySettings.playlist_order),
  );
  const shownAlbums = createMemo(() =>
    libraryAlbums().length > 0 ? libraryAlbums() : deriveAlbumsFromTracks(musicLibrary()),
  );
  const songs = createMemo(() => musicLibrary());

  const activeTab = () => libraryTab() ?? (shownAlbums().length ? 'albums'
    : savedPlaylists().length ? 'playlists' : songs().length ? 'songs' : 'albums');

  let disposed = false;
  let loadGen = 0;
  let requestedDepth = 0;

  onCleanup(() => {
    disposed = true;
  });

  async function loadAlbumsPage(
    offset: number,
    opts?: { focusFirstAppended?: boolean; limit?: number; revision?: number },
  ): Promise<void> {
    const pageLimit = opts?.limit ?? TV_LIBRARY_ALBUM_PAGE_SIZE;
    const gen = ++loadGen;
    const targetRevision = opts?.revision ?? state.catalog.revision;
    requestedDepth = Math.max(requestedDepth, offset + pageLimit);
    setLoadingMoreAlbums(true);
    try {
      const items = await api.getLibraryAlbums({
        sort: 'alphabeticalByName',
        limit: pageLimit + 1,
        offset,
      });
      if (disposed || gen !== loadGen) return;
      const hasMore = items.length > pageLimit;
      const page = hasMore ? items.slice(0, pageLimit) : items;
      let appendedStartIndex = 0;
      let totalAfter = page.length;
      batch(() => {
        if (offset === 0) {
          setLibraryAlbums(page);
        } else {
          setLibraryAlbums((prev) => {
            appendedStartIndex = prev.length;
            const seen = new Set(prev.map((a) => a.id));
            const merged = [...prev, ...page.filter((a) => !seen.has(a.id))];
            totalAfter = merged.length;
            return merged;
          });
        }
        setLibraryAlbumsNextOffset(offset + page.length);
        setLibraryAlbumsHasMore(hasMore);
        setLibraryAlbumsRevision(targetRevision);
      });
      if (opts?.focusFirstAppended && appendedStartIndex < totalAfter) {
        queueMicrotask(() => {
          focus.focusById(`lib-album-${appendedStartIndex}`);
        });
      }
    } catch {
      // Fall back to locally derived albums from musicLibrary when unreachable.
    } finally {
      if (!disposed && gen === loadGen) {
        setLoadingMoreAlbums(false);
      }
    }
  }

  createEffect(() => {
    const rev = state.catalog.revision;
    if (untrack(libraryAlbumsRevision) === rev) return;
    const preserveCount = Math.max(
      TV_LIBRARY_ALBUM_PAGE_SIZE,
      untrack(libraryAlbumsNextOffset),
      requestedDepth,
    );
    void loadAlbumsPage(0, { limit: preserveCount, revision: rev });
  });

  function loadNextAlbumsPage(): void {
    if (loadingMoreAlbums()) return;
    void loadAlbumsPage(libraryAlbumsNextOffset(), { focusFirstAppended: true });
  }

  function selectTab(next: TvLibraryTab): void {
    setLibraryTab(next);
  }

  return (
    <>
      <header class={styles.tvHeaderBar}>
        <h1 class={styles.tvPageTitle}>{t('tv.nav.library')}</h1>
      </header>

      <div
        class={styles.tvTabs}
        data-tv-group-container="lib-tabs"
        data-tv-group-kind="row"
        data-tv-group-order="10"
        role="tablist"
      >
        <For each={['albums', 'playlists', 'songs'] as const}>
          {(tab, idx) => {
            const tvId = () => `lib-tab-${tab}`;
            const label = () =>
              tab === 'playlists'
                ? t('tv.library.playlistsTab')
                : tab === 'albums'
                  ? t('tv.library.albumsTab')
                  : t('tv.library.songsTab');
            return (
              <Control
                role="tab"
                aria-selected={activeTab() === tab}
                data-tv-id={tvId()}
                data-tv-group="lib-tabs"
                data-tv-index={String(idx())}
                data-tv-focused={focus.activeId() === tvId() ? 'true' : undefined}
                class={styles.tvSecondaryBtn}
                classList={{
                  [styles.tvFocusTarget]: true,
                  [styles.tvSelectedBtn]: activeTab() === tab,
                }}
                onClick={() => selectTab(tab)}
              >
                {label()}
              </Control>
            );
          }}
        </For>
      </div>

      <Show when={activeTab() === 'playlists'}>
        <Show
          when={savedPlaylists().length > 0}
          fallback={<p class={styles.tvSubtitle}>{t('tv.library.emptyPlaylists')}</p>}
        >
          <div
            class={styles.tvGrid}
            data-tv-group-container="lib-playlists"
            data-tv-group-kind="grid"
            data-tv-group-order="20"
          >
            <For each={savedPlaylists()}>
              {(name, idx) => {
                const tvId = () => `lib-playlist-${idx()}`;
                const count = () => state.playlists[name]?.length ?? 0;
                return (
                  <TvCard
                    id={tvId()}
                    group="lib-playlists"
                    index={idx()}
                    title={name}
                    subtitle={trackCount(count())}
                    artwork={playlistCoverUrl(name, state.playlists, trackIndex(), state.librarySettings)}
                    onActivate={() => props.onNavigate(playlistTvHash(name))}
                  />
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={activeTab() === 'albums'}>
        <Show
          when={shownAlbums().length > 0}
          fallback={<p class={styles.tvSubtitle}>{t('tv.library.emptyAlbums')}</p>}
        >
          <div
            class={styles.tvGrid}
            data-tv-group-container="lib-albums"
            data-tv-group-kind="grid"
            data-tv-group-order="20"
          >
            <For each={shownAlbums()}>
              {(album, idx) => {
                const tvId = () => `lib-album-${idx()}`;
                return (
                  <TvCard
                    id={tvId()}
                    group="lib-albums"
                    index={idx()}
                    title={album.title}
                    subtitle={album.album_artist || t('tv.library.unknownArtist')}
                    artwork={albumCoverUrl(album)}
                    onActivate={() =>
                      props.onNavigate(
                        albumTvHash({ id: album.id, name: album.title, artist: album.album_artist }),
                      )
                    }
                  />
                );
              }}
            </For>
          </div>
          <Show when={libraryAlbumsHasMore()}>
            <div
              class={styles.tvRowGroup}
              data-tv-group-container="lib-albums-more"
              data-tv-group-kind="row"
              data-tv-group-order="30"
            >
              <Control
                data-tv-id="lib-albums-load-more"
                data-tv-group="lib-albums-more"
                data-tv-index="0"
                data-tv-focused={focus.activeId() === 'lib-albums-load-more' ? 'true' : undefined}
                class={styles.tvSecondaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                disabled={loadingMoreAlbums()}
                onClick={loadNextAlbumsPage}
              >
                {loadingMoreAlbums() ? t('tv.library.loadingMoreAlbums') : t('tv.library.loadMoreAlbums')}
              </Control>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={activeTab() === 'songs'}>
        <Show
          when={songs().length > 0}
          fallback={<p class={styles.tvSubtitle}>{t('tv.library.emptySongs')}</p>}
        >
          <TvVirtualList
            items={songs()}
            groupId="lib-songs"
            order={20}
            renderRow={(track, index, tvId) => {
              const playing = () => isPlayingTrack(track());
              return (
                <TvTrackRow
                  id={tvId()}
                  group="lib-songs"
                  index={index()}
                  title={track().title}
                  artist={track().artist}
                  artwork={trackCoverUrl(track(), 'thumb')}
                  duration={track().duration}
                  playing={playing()}
                  onActivate={() =>
                    actions.playFrom(songs(), index(), {
                      context: libraryContext(t('tv.library.songsTab')),
                    })
                  }
                />
              );
            }}
          />
        </Show>
      </Show>
    </>
  );
}
