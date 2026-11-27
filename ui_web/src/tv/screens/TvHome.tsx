import { createEffect, createMemo, For, Show } from 'solid-js';
import { ArtistIcon, PlayFilledIcon, QueueListIcon } from '../../components/icons';
import { Control } from '../../design/Control';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { playlistNames } from '../../lib/playlistOrder';
import { user } from '../../lib/session';
import { actions, musicLibrary, resumeState, state } from '../../stores';
import type { CatalogAlbum } from '../../types/music';
import { TvCard } from '../components/TvCard';
import { TvArtwork, TvArtworkBackdrop } from '../components/TvArtwork';
import { useTvFocus } from '../nav/spatial';
import { albumTvHash, playlistTvHash } from '../nav/router';
import {
  albumCoverUrl,
  buildTrackIndex,
  deriveAlbumsFromTracks,
  playlistCoverUrl,
} from '../tvLibraryHelpers';
import styles from '../styles/tv.module.css';

interface TvHomeProps {
  recentAlbums: CatalogAlbum[];
  newestAlbums: CatalogAlbum[];
  onNavigate: (hash: string) => void;
}

export function TvHome(props: TvHomeProps) {
  const focus = useTvFocus();
  const trackIndex = createMemo(() => buildTrackIndex(musicLibrary(), state.library));
  const fallbackAlbums = createMemo(() => deriveAlbumsFromTracks(musicLibrary()));

  const shownLibraryAlbums = createMemo(() =>
    props.newestAlbums.length > 0 ? props.newestAlbums : fallbackAlbums().slice(0, 16),
  );
  const savedPlaylistNames = createMemo(() =>
    playlistNames(state.playlists, state.librarySettings.playlist_order),
  );

  const resumableTrack = () => state.playback.currentTrack ?? resumeState()?.track ?? null;
  const firstTrack = createMemo(() => {
    const recentCover = props.recentAlbums[0]?.cover_track_id;
    return (recentCover && trackIndex().get(recentCover)) || musicLibrary()[0];
  });
  const featuredTrack = () => resumableTrack() || firstTrack();
  const playingHere = () => Boolean(state.playback.currentTrack && state.playback.isPlaying);
  const accountLabel = () => user()?.display_name || user()?.username || '';

  const isEmptyLibrary = () =>
    state.libraryReady &&
    !resumableTrack() &&
    musicLibrary().length === 0 &&
    savedPlaylistNames().length === 0 &&
    props.recentAlbums.length === 0 &&
    shownLibraryAlbums().length === 0;

  createEffect(() => {
    const candidate = featuredTrack() ? 'home-feature-action'
      : props.recentAlbums.length ? 'home-recent-0'
      : savedPlaylistNames().length ? 'home-playlist-0'
      : shownLibraryAlbums().length ? 'home-album-0'
      : isEmptyLibrary() ? 'home-empty-search' : null;
    if (candidate) queueMicrotask(() => {
      if (document.activeElement === document.body) focus.focusById(candidate);
    });
  });

  function playFeatured(): void {
    if (state.playback.currentTrack) {
      if (state.playback.isPlaying) {
        props.onNavigate('#/now-playing');
      } else {
        actions.resumePlayback();
      }
      return;
    }
    if (resumeState()) {
      actions.resumeHere();
    } else {
      const track = firstTrack();
      if (track) actions.playTrack(track);
    }
  }

  return (
    <>
      <header class={styles.tvHeaderBar}>
        <h1 class={styles.tvPageTitle}>{t('tv.nav.home')}</h1>
        <Show when={accountLabel()}>
          <span class={styles.tvAccountStrip} aria-label={t('tv.home.signedInBadge', { name: accountLabel() })}>
            <ArtistIcon /> {accountLabel()}
          </span>
        </Show>
      </header>

      <Show when={featuredTrack()}>
        {(track) => (
          <section class={styles.tvFeature} data-stage-surface>
            <TvArtworkBackdrop src={trackCoverUrl(track(), 'thumb')} />
            <div class={styles.tvResumeBody}>
              <span class={styles.tvEyebrow}>
                {playingHere() ? t('tv.player.playingNow') : resumableTrack() ? t('tv.home.resumeTitle') : t('tv.nav.library')}
              </span>
              <h2 class={styles.tvHeroTitle}>{track().title}</h2>
              <p class={styles.tvSubtitle}>{[track().artist, track().album].filter(Boolean).join(' · ')}</p>
              <div data-tv-group-container="home-feature" data-tv-group-kind="row" data-tv-group-order="10">
                <Control
                  data-tv-id="home-feature-action"
                  data-tv-group="home-feature"
                  data-tv-index="0"
                  data-tv-focused={focus.activeId() === 'home-feature-action' ? 'true' : undefined}
                  class={styles.tvPrimaryBtn}
                  classList={{ [styles.tvFocusTarget]: true }}
                  onClick={playFeatured}
                >
                  {playingHere() ? <QueueListIcon /> : <PlayFilledIcon />}
                  {playingHere() ? t('tv.nav.nowPlaying') : resumableTrack() ? t('tv.resume') : t('tv.play')}
                </Control>
              </div>
            </div>
            <div class={styles.tvSleeve} aria-hidden="true">
              <TvArtwork class={styles.tvResumeArt} src={trackCoverUrl(track())} alt="" fallbackLabel={track().title} />
            </div>
          </section>
        )}
      </Show>

      <Show when={isEmptyLibrary()}>
        <section
          class={styles.tvEmptyPanel}
          data-tv-group-container="home-empty"
          data-tv-group-kind="row"
          data-tv-group-order="15"
        >
          <h2 class={styles.tvSectionTitle}>{t('tv.home.emptyTitle')}</h2>
          <p class={styles.tvSubtitle}>{t('tv.home.emptyHint')}</p>
          <Control
            data-tv-id="home-empty-search"
            data-tv-group="home-empty"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'home-empty-search' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={() => props.onNavigate('#/search')}
          >
            {t('tv.home.searchCta')}
          </Control>
        </section>
      </Show>

      <Show when={props.recentAlbums.length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="home-recent-title">
          <h2 id="home-recent-title" class={styles.tvSectionTitle}>{t('tv.home.recent')}</h2>
          <div
            class={styles.tvShelfRow}
            data-tv-scroll-x="home-recent"
            data-tv-group-container="home-recent"
            data-tv-group-kind="shelf"
            data-tv-group-order="20"
          >
            <For each={props.recentAlbums}>
              {(album, idx) => {
                const tvId = () => `home-recent-${idx()}`;
                return (
                  <TvCard
                    id={tvId()}
                    group="home-recent"
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
        </section>
      </Show>

      <Show when={savedPlaylistNames().length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="home-playlists-title">
          <h2 id="home-playlists-title" class={styles.tvSectionTitle}>{t('tv.home.playlists')}</h2>
          <div
            class={styles.tvShelfRow}
            data-tv-scroll-x="home-playlists"
            data-tv-group-container="home-playlists"
            data-tv-group-kind="shelf"
            data-tv-group-order="30"
          >
            <For each={savedPlaylistNames()}>
              {(name, idx) => {
                const tvId = () => `home-playlist-${idx()}`;
                const count = () => state.playlists[name]?.length ?? 0;
                return (
                  <TvCard
                    id={tvId()}
                    group="home-playlists"
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
        </section>
      </Show>

      <Show when={shownLibraryAlbums().length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="home-albums-title">
          <h2 id="home-albums-title" class={styles.tvSectionTitle}>{t('tv.home.albums')}</h2>
          <div
            class={styles.tvShelfRow}
            data-tv-scroll-x="home-albums"
            data-tv-group-container="home-albums"
            data-tv-group-kind="shelf"
            data-tv-group-order="40"
          >
            <For each={shownLibraryAlbums()}>
              {(album, idx) => {
                const tvId = () => `home-album-${idx()}`;
                return (
                  <TvCard
                    id={tvId()}
                    group="home-albums"
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
        </section>
      </Show>
    </>
  );
}
