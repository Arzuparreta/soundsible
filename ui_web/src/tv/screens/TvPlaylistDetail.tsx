import { createMemo, Show } from 'solid-js';
import { BackIcon, PlayFilledIcon } from '../../components/icons';
import { EntityIdentity } from '../../design/EntityIdentity';
import { Control } from '../../design/Control';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { playlistContext } from '../../lib/playbackContext';
import { actions, isPlayingTrack, musicLibrary, state } from '../../stores';
import { TvArtwork } from '../components/TvArtwork';
import { TvTrackRow } from '../components/TvTrackRow';
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
  const trackIndex = createMemo(() => buildTrackIndex(state.collectionItems ?? musicLibrary(), state.library));

  const tracks = createMemo(() =>
    resolvePlaylistTracks(props.playlistName, state.playlists, trackIndex()),
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
      <section class={styles.tvDetailHero}>
        <TvArtwork
          class={styles.tvDetailArt}
          src={cover()}
          alt={props.playlistName}
          fallbackLabel={props.playlistName}
        />
        <div class={styles.tvDetailInfo}>
          <span class={styles.tvEyebrow}>{t('nowPlaying.contextKind.playlist')}</span>
          <EntityIdentity
            class={styles.tvIdentityText}
            headingClass={styles.tvHeroTitle}
            title={props.playlistName}
            metadata={<p class={styles.tvSubtitle}>{trackCount(tracks().length)}</p>}
          />
          <div
            class={styles.tvRowGroup}
            data-tv-group-container="playlist-actions"
            data-tv-group-kind="row"
            data-tv-group-order="10"
          >
            <Show when={tracks().length > 0}>
              <Control
                data-tv-id="playlist-play-btn"
                data-tv-group="playlist-actions"
                data-tv-index="0"
                data-tv-focused={focus.activeId() === 'playlist-play-btn' ? 'true' : undefined}
                class={styles.tvPrimaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                onClick={() => playAt(0)}
              >
                <PlayFilledIcon /> {t('tv.library.playAll')}
              </Control>
            </Show>
            <Control
              data-tv-id="playlist-back-btn"
              data-tv-group="playlist-actions"
              data-tv-index="1"
              data-tv-focused={focus.activeId() === 'playlist-back-btn' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={props.onBack}
            >
              <BackIcon /> {t('tv.back')}
            </Control>
          </div>
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
          renderRow={(track, index, tvId) => {
            const playing = () => isPlayingTrack(track());
            return (
              <TvTrackRow
                id={tvId()}
                group="playlist-tracks"
                index={index()}
                title={track().title}
                artist={track().artist}
                artwork={trackCoverUrl(track(), 'thumb')}
                duration={track().duration}
                playing={playing()}
                onActivate={() => playAt(index())}
              />
            );
          }}
        />
      </Show>
    </>
  );
}
