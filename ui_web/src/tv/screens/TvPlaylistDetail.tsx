import { createMemo, Show } from 'solid-js';
import { Control } from '../../design/Control';
import { formatDuration, trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { playlistContext } from '../../lib/playbackContext';
import { actions, isPlayingTrack, musicLibrary, state } from '../../stores';
import { TvArtwork } from '../components/TvArtwork';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { buildTrackIndex, playlistCoverUrl, resolvePlaylistTracks } from '../tvLibraryHelpers';
import styles from '../styles/tv.module.css';

interface TvPlaylistDetailProps {
  playlistName: string;
  onBack: () => void;
}

export function TvPlaylistDetail(props: TvPlaylistDetailProps) {
  const focus = useTvFocus();
  const trackIndex = createMemo(() => buildTrackIndex(musicLibrary(), state.library));

  const tracks = createMemo(() =>
    resolvePlaylistTracks(props.playlistName, state.playlists, musicLibrary(), state.library),
  );

  const cover = createMemo(() =>
    playlistCoverUrl(props.playlistName, state.playlists, trackIndex(), state.librarySettings),
  );

  function playAt(index: number): void {
    const list = tracks();
    if (!list.length) return;
    const context = playlistContext(props.playlistName, list, state.librarySettings);
    actions.playFrom(list, index, { context });
  }

  return (
    <>
      <div
        class={styles.tvRowGroup}
        data-tv-group-container="playlist-actions"
        data-tv-group-kind="row"
        data-tv-group-order="10"
      >
        <Control
          data-tv-id="playlist-back-btn"
          data-tv-group="playlist-actions"
          data-tv-index="0"
          data-tv-focused={focus.activeId() === 'playlist-back-btn' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{ [styles.tvFocusTarget]: true }}
          onClick={props.onBack}
        >
          ← {t('tv.back')}
        </Control>
        <Show when={tracks().length > 0}>
          <Control
            data-tv-id="playlist-play-btn"
            data-tv-group="playlist-actions"
            data-tv-index="1"
            data-tv-focused={focus.activeId() === 'playlist-play-btn' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={() => playAt(0)}
          >
            ▶ {t('tv.library.playAll')}
          </Control>
        </Show>
      </div>

      <section class={styles.tvDetailHero}>
        <TvArtwork
          class={styles.tvDetailArt}
          src={cover()}
          alt={props.playlistName}
          fallbackLabel={props.playlistName}
        />
        <div class={styles.tvDetailInfo}>
          <h1 class={styles.tvHeroTitle}>{props.playlistName}</h1>
          <p class={styles.tvSubtitle}>{trackCount(tracks().length)}</p>
        </div>
      </section>

      <Show
        when={tracks().length > 0}
        fallback={<p class={styles.tvSubtitle}>{t('tv.library.emptySongs')}</p>}
      >
        <TvVirtualList
          items={tracks()}
          groupId="playlist-tracks"
          order={20}
          maxVisible={16}
          renderRow={(track, index, tvId) => {
            const playing = () => isPlayingTrack(track);
            return (
              <Control
                role="listitem"
                data-tv-id={tvId}
                data-tv-group="playlist-tracks"
                data-tv-index={String(index)}
                data-tv-focused={focus.activeId() === tvId ? 'true' : undefined}
                class={styles.tvTrackRow}
                classList={{
                  [styles.tvFocusTarget]: true,
                  [styles.tvTrackRowPlaying]: playing(),
                }}
                onClick={() => playAt(index)}
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
    </>
  );
}
