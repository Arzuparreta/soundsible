import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { Control } from '../../design/Control';
import { api } from '../../lib/api';
import { formatDuration, trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { libraryContext } from '../../lib/playbackContext';
import { playlistNames } from '../../lib/playlistOrder';
import { actions, isPlayingTrack, musicLibrary, state } from '../../stores';
import type { CatalogAlbum } from '../../types/music';
import { TvArtwork } from '../components/TvArtwork';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { albumTvHash, playlistTvHash } from '../nav/router';
import { libraryTab, setLibraryTab, type TvLibraryTab } from '../state';
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

export function TvLibrary(props: TvLibraryProps) {
  const focus = useTvFocus();
  const [albums, setAlbums] = createSignal<CatalogAlbum[]>([]);

  const trackIndex = createMemo(() => buildTrackIndex(musicLibrary(), state.library));
  const savedPlaylists = createMemo(() =>
    playlistNames(state.playlists, state.librarySettings.playlist_order),
  );
  const shownAlbums = createMemo(() =>
    albums().length > 0 ? albums() : deriveAlbumsFromTracks(musicLibrary()),
  );
  const songs = createMemo(() => musicLibrary());

  onMount(() => {
    void api.getLibraryAlbums({ sort: 'alphabeticalByName', limit: 200 })
      .then((items) => setAlbums(items))
      .catch(() => {});
  });

  function selectTab(next: TvLibraryTab): void {
    setLibraryTab(next);
  }

  return (
    <>
      <header class={styles.tvHeaderBar}>
        <h1 class={styles.tvPageTitle}>{t('tv.nav.library')}</h1>
      </header>

      <div
        class={styles.tvRowGroup}
        data-tv-group-container="lib-tabs"
        data-tv-group-kind="row"
        data-tv-group-order="10"
        role="tablist"
      >
        <For each={['playlists', 'albums', 'songs'] as const}>
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
                aria-selected={libraryTab() === tab}
                data-tv-id={tvId()}
                data-tv-group="lib-tabs"
                data-tv-index={String(idx())}
                data-tv-focused={focus.activeId() === tvId() ? 'true' : undefined}
                class={styles.tvSecondaryBtn}
                classList={{
                  [styles.tvFocusTarget]: true,
                  [styles.tvSelectedBtn]: libraryTab() === tab,
                }}
                onClick={() => selectTab(tab)}
              >
                {label()}
              </Control>
            );
          }}
        </For>
      </div>

      <Show when={libraryTab() === 'playlists'}>
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
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="lib-playlists"
                    data-tv-index={String(idx())}
                    data-tv-focused={focus.activeId() === tvId() ? 'true' : undefined}
                    class={styles.tvCard}
                    classList={{ [styles.tvFocusTarget]: true }}
                    onClick={() => props.onNavigate(playlistTvHash(name))}
                  >
                    <TvArtwork
                      class={styles.tvCardArt}
                      src={playlistCoverUrl(name, state.playlists, trackIndex(), state.librarySettings)}
                      alt={name}
                      fallbackLabel={name}
                    />
                    <span class={styles.tvCardTitle}>{name}</span>
                    <span class={styles.tvCardMeta}>{trackCount(count())}</span>
                  </Control>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={libraryTab() === 'albums'}>
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
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="lib-albums"
                    data-tv-index={String(idx())}
                    data-tv-focused={focus.activeId() === tvId() ? 'true' : undefined}
                    class={styles.tvCard}
                    classList={{ [styles.tvFocusTarget]: true }}
                    onClick={() =>
                      props.onNavigate(
                        albumTvHash({ id: album.id, name: album.title, artist: album.album_artist }),
                      )
                    }
                  >
                    <TvArtwork
                      class={styles.tvCardArt}
                      src={albumCoverUrl(album)}
                      alt={album.title}
                      fallbackLabel={album.title}
                    />
                    <span class={styles.tvCardTitle}>{album.title}</span>
                    <span class={styles.tvCardMeta}>
                      {album.album_artist || t('tv.library.unknownArtist')}
                    </span>
                  </Control>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={libraryTab() === 'songs'}>
        <Show
          when={songs().length > 0}
          fallback={<p class={styles.tvSubtitle}>{t('tv.library.emptySongs')}</p>}
        >
          <TvVirtualList
            items={songs()}
            groupId="lib-songs"
            order={20}
            maxVisible={16}
            renderRow={(track, index, tvId) => {
              const playing = () => isPlayingTrack(track);
              return (
                <Control
                  role="listitem"
                  data-tv-id={tvId}
                  data-tv-group="lib-songs"
                  data-tv-index={String(index)}
                  data-tv-focused={focus.activeId() === tvId ? 'true' : undefined}
                  class={styles.tvTrackRow}
                  classList={{
                    [styles.tvFocusTarget]: true,
                    [styles.tvTrackRowPlaying]: playing(),
                  }}
                  onClick={() =>
                    actions.playFrom(songs(), index, {
                      context: libraryContext(t('tv.library.songsTab')),
                    })
                  }
                >
                  <TvArtwork
                    class={styles.tvTrackArt}
                    src={trackCoverUrl(track, 'thumb')}
                    alt={track.title}
                    fallbackLabel={track.title}
                  />
                  <div class={styles.tvTrackMain}>
                    <span class={styles.tvTrackTitle}>{track.title}</span>
                    <span class={styles.tvTrackSub}>{track.artist}</span>
                  </div>
                  <Show when={playing()}>
                    <span class={styles.tvPlayingBadge}>{t('tv.player.playingNow')}</span>
                  </Show>
                  <span class={styles.tvTrackDuration}>{formatDuration(track.duration)}</span>
                </Control>
              );
            }}
          />
        </Show>
      </Show>
    </>
  );
}
