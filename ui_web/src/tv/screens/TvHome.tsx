import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Control } from '../../design/Control';
import { api } from '../../lib/api';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { playlistNames } from '../../lib/playlistOrder';
import { requiresLogin, user } from '../../lib/session';
import { actions, musicLibrary, resumeState, state } from '../../stores';
import type { CatalogAlbum } from '../../types/music';
import { TvArtwork } from '../components/TvArtwork';
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
  onNavigate: (hash: string) => void;
  onRequestSignOut: () => void;
}

export function TvHome(props: TvHomeProps) {
  const focus = useTvFocus();
  const [recentAlbums, setRecentAlbums] = createSignal<CatalogAlbum[]>([]);
  const [newestAlbums, setNewestAlbums] = createSignal<CatalogAlbum[]>([]);

  const trackIndex = createMemo(() => buildTrackIndex(musicLibrary(), state.library));
  const fallbackAlbums = createMemo(() => deriveAlbumsFromTracks(musicLibrary()));

  const shownRecentAlbums = createMemo(() =>
    recentAlbums().length > 0 ? recentAlbums() : fallbackAlbums().slice(0, 12),
  );
  const shownLibraryAlbums = createMemo(() =>
    newestAlbums().length > 0 ? newestAlbums() : fallbackAlbums().slice(0, 16),
  );
  const savedPlaylistNames = createMemo(() =>
    playlistNames(state.playlists, state.librarySettings.playlist_order),
  );

  const resumableTrack = () => state.playback.currentTrack ?? resumeState()?.track ?? null;
  const accountLabel = () => user()?.display_name || user()?.username || '';

  const isEmptyLibrary = () =>
    state.libraryReady &&
    !resumableTrack() &&
    musicLibrary().length === 0 &&
    savedPlaylistNames().length === 0 &&
    shownRecentAlbums().length === 0 &&
    shownLibraryAlbums().length === 0;

  let initialFocusApplied = false;
  let resumeFocusApplied = false;
  let initialFallbackId: string | null = null;
  let userMovedFocus = false;

  function maybeApplyInitialFocus(): void {
    const active = focus.activeId();
    const bodyFocused = typeof document === 'undefined' || document.activeElement === document.body;

    // If playback resume state arrives shortly after initial library load,
    // promote initial focus to the top Resume card unless the user already navigated away.
    if (
      resumableTrack() &&
      !resumeFocusApplied &&
      !userMovedFocus &&
      (!active || bodyFocused || active === initialFallbackId)
    ) {
      if (focus.focusById('home-resume-btn')) {
        resumeFocusApplied = true;
        initialFocusApplied = true;
        initialFallbackId = null;
        return;
      }
    }

    if (initialFocusApplied) return;
    if (active && !bodyFocused) {
      initialFocusApplied = true;
      return;
    }
    const candidates = [
      shownRecentAlbums().length > 0 ? 'home-recent-0' : null,
      savedPlaylistNames().length > 0 ? 'home-playlist-0' : null,
      shownLibraryAlbums().length > 0 ? 'home-album-0' : null,
      isEmptyLibrary() ? 'home-empty-search' : null,
    ].filter((id): id is string => Boolean(id));

    for (const candidate of candidates) {
      initialFallbackId = candidate;
      if (focus.focusById(candidate)) {
        initialFocusApplied = true;
        return;
      }
      initialFallbackId = null;
    }
  }

  onMount(() => {
    const markInteracted = () => {
      userMovedFocus = true;
    };
    window.addEventListener('keydown', markInteracted, { capture: true, once: true });
    window.addEventListener('pointerdown', markInteracted, { capture: true, once: true });

    void api.getLibraryAlbums({ sort: 'recent', limit: 12 })
      .then((albums) => setRecentAlbums(albums))
      .catch(() => {});
    void api.getLibraryAlbums({ sort: 'newest', limit: 16 })
      .then((albums) => setNewestAlbums(albums))
      .catch(() => {});
    queueMicrotask(maybeApplyInitialFocus);

    onCleanup(() => {
      window.removeEventListener('keydown', markInteracted, true);
      window.removeEventListener('pointerdown', markInteracted, true);
    });
  });

  createEffect(() => {
    const active = focus.activeId();
    if (active && active !== initialFallbackId && active !== 'home-resume-btn') {
      userMovedFocus = true;
    }
  });

  createEffect(() => {
    void state.libraryReady;
    void state.catalog.revision;
    void resumableTrack();
    queueMicrotask(maybeApplyInitialFocus);
  });

  function handleResume(): void {
    if (state.playback.currentTrack) {
      if (state.playback.isPlaying) {
        props.onNavigate('#/now-playing');
      } else {
        actions.resumePlayback();
      }
      return;
    }
    if (resumeState()) {
      const hadFocus = focus.activeId() === 'home-resume-btn';
      actions.resumeHere();
      if (hadFocus && !focus.focusById('home-resume-btn')) {
        queueMicrotask(() => {
          focus.focusById('home-resume-btn');
        });
      }
    }
  }

  return (
    <>
      <header
        class={styles.tvHeaderBar}
        data-tv-group-container="home-header"
        data-tv-group-kind="row"
        data-tv-group-order="5"
      >
        <h1 class={styles.tvPageTitle}>{t('tv.nav.home')}</h1>
        <div class={styles.tvAccountStrip}>
          <Show when={accountLabel()}>
            <span class={styles.tvAccountPill}>
              {t('tv.home.signedInBadge', { name: accountLabel() })}
            </span>
          </Show>
          <Show when={requiresLogin()}>
            <Control
              data-tv-id="home-signout-btn"
              data-tv-group="home-header"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'home-signout-btn' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={props.onRequestSignOut}
            >
              {t('tv.signOut')}
            </Control>
          </Show>
        </div>
      </header>

      <Show when={resumableTrack()}>
        {(track) => (
          <div
            data-tv-group-container="home-resume"
            data-tv-group-kind="row"
            data-tv-group-order="10"
          >
            <Control
              data-tv-id="home-resume-btn"
              data-tv-group="home-resume"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'home-resume-btn' ? 'true' : undefined}
              class={styles.tvResumeCard}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={handleResume}
            >
              <TvArtwork
                class={styles.tvResumeArt}
                src={trackCoverUrl(track(), 'thumb')}
                alt={track().title}
                fallbackLabel={track().title}
              />
              <div class={styles.tvResumeBody}>
                <span class={styles.tvEyebrow}>{t('tv.home.resumeTitle')}</span>
                <strong class={styles.tvPageTitle}>{track().title}</strong>
                <span class={styles.tvSubtitle}>
                  {track().artist} · {state.playback.isPlaying ? t('tv.player.playingNow') : t('tv.home.resumeOk')}
                </span>
              </div>
            </Control>
          </div>
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

      <Show when={shownRecentAlbums().length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="home-recent-title">
          <h2 id="home-recent-title" class={styles.tvSectionTitle}>{t('tv.home.recent')}</h2>
          <div
            class={styles.tvShelfRow}
            data-tv-scroll-x="home-recent"
            data-tv-group-container="home-recent"
            data-tv-group-kind="shelf"
            data-tv-group-order="20"
          >
            <For each={shownRecentAlbums()}>
              {(album, idx) => {
                const tvId = () => `home-recent-${idx()}`;
                return (
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="home-recent"
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
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="home-playlists"
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
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="home-albums"
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
        </section>
      </Show>
    </>
  );
}
