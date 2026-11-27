import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { Control } from '../../design/Control';
import { api } from '../../lib/api';
import { playCatalogItem } from '../../lib/catalogItem';
import { catalogTrack } from '../../lib/catalogTrack';
import { formatDuration, trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { coverUrl, trackCoverUrl } from '../../lib/media';
import type { PlaybackContextDescriptor } from '../../lib/playbackQueue';
import { actions, isPlayingTrack, musicLibrary, state } from '../../stores';
import type { CatalogAlbum, CatalogItem, Track } from '../../types/music';
import { TvArtwork } from '../components/TvArtwork';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { matchAlbumTracks, safeExternalCover } from '../tvLibraryHelpers';
import styles from '../styles/tv.module.css';

type AlbumRow =
  | { kind: 'local'; track: Track }
  | { kind: 'catalog'; item: CatalogItem; resolved: Track | null };

interface TvAlbumDetailProps {
  albumId: string;
  albumName: string;
  artist: string;
  deezerId?: string;
  onBack: () => void;
}

export function TvAlbumDetail(props: TvAlbumDetailProps) {
  const focus = useTvFocus();
  const [album, setAlbum] = createSignal<CatalogAlbum | null>(null);
  const [trackIds, setTrackIds] = createSignal<string[]>([]);
  const [catalogTracks, setCatalogTracks] = createSignal<CatalogItem[]>([]);
  const [externalCover, setExternalCover] = createSignal<string | undefined>(undefined);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);

  let loadGen = 0;

  async function loadAlbum(signal?: AbortSignal): Promise<void> {
    const gen = ++loadGen;

    setLoading(true);
    setError(false);

    if (!props.albumId.includes('::')) {
      try {
        const res = await api.getLibraryAlbum(props.albumId);
        if (gen !== loadGen || signal?.aborted) return;
        setAlbum(res.album);
        setTrackIds(res.track_ids ?? []);
        setCatalogTracks([]);
        setExternalCover(
          res.album.cover_track_id ? coverUrl(res.album.cover_track_id, 'thumb') : undefined,
        );
        setLoading(false);
        return;
      } catch {
        // Fall through to catalog profile lookup or local track match.
      }
    }

    if (props.deezerId || props.albumName) {
      try {
        const profile = await api.getAlbumProfile(
          props.albumName,
          props.artist,
          props.deezerId,
          signal,
        );
        if (gen !== loadGen || signal?.aborted) return;
        setCatalogTracks(profile.tracklist ?? []);
        setExternalCover(safeExternalCover(profile.cover));
        setLoading(false);
        return;
      } catch {
        // Fall through to local track matching or error state.
      }
    }

    const localFallback = matchAlbumTracks(
      { id: props.albumId, title: props.albumName, album_artist: props.artist },
      [],
      musicLibrary(),
      state.library,
    );
    if (gen === loadGen && !signal?.aborted) {
      setLoading(false);
      if (localFallback.length === 0) setError(true);
    }
  }

  createEffect(() => {
    void props.albumId;
    void props.albumName;
    void props.artist;
    void props.deezerId;
    const ac = new AbortController();
    onCleanup(() => ac.abort());
    void loadAlbum(ac.signal);
  });

  const localTracks = createMemo<Track[]>(() =>
    matchAlbumTracks(
      album() ?? { id: props.albumId, title: props.albumName, album_artist: props.artist },
      trackIds(),
      musicLibrary(),
      state.library,
    ),
  );

  const displayTitle = () => album()?.title || props.albumName;
  const displayArtist = () => album()?.album_artist || props.artist || t('tv.library.unknownArtist');
  const contextDescriptor = (): PlaybackContextDescriptor => ({
    id: `album:${props.albumId}`,
    kind: 'album',
    label: displayTitle(),
    cover: externalCover(),
  });

  function playAt(index: number): void {
    const locals = localTracks();
    if (locals.length > 0) {
      actions.playFrom(locals, index, { context: contextDescriptor() });
      return;
    }
    const items = catalogTracks();
    const chosen = items[index];
    if (chosen) {
      void playCatalogItem(chosen, items, contextDescriptor());
    }
  }

  const rows = createMemo<AlbumRow[]>(() => {
    const locals = localTracks();
    if (locals.length > 0) {
      return locals.map((track): AlbumRow => ({ kind: 'local', track }));
    }
    return catalogTracks().map((item): AlbumRow => ({
      kind: 'catalog',
      item,
      resolved: catalogTrack(item, state.library),
    }));
  });

  return (
    <>
      <div
        class={styles.tvRowGroup}
        data-tv-group-container="album-actions"
        data-tv-group-kind="row"
        data-tv-group-order="10"
      >
        <Control
          data-tv-id="album-back-btn"
          data-tv-group="album-actions"
          data-tv-index="0"
          data-tv-focused={focus.activeId() === 'album-back-btn' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{ [styles.tvFocusTarget]: true }}
          onClick={props.onBack}
        >
          ← {t('tv.back')}
        </Control>
        <Show when={rows().length > 0}>
          <Control
            data-tv-id="album-play-btn"
            data-tv-group="album-actions"
            data-tv-index="1"
            data-tv-focused={focus.activeId() === 'album-play-btn' ? 'true' : undefined}
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
          src={externalCover()}
          alt={displayTitle()}
          fallbackLabel={displayTitle()}
        />
        <div class={styles.tvDetailInfo}>
          <h1 class={styles.tvHeroTitle}>{displayTitle()}</h1>
          <p class={styles.tvSubtitle}>
            {displayArtist()} · {trackCount(rows().length)}
          </p>
        </div>
      </section>

      <Show when={loading()}>
        <p class={styles.tvSubtitle} role="status">{t('tv.library.loadingDetail')}</p>
      </Show>

      <Show when={error() && !loading() && rows().length === 0}>
        <div
          class={styles.tvEmptyPanel}
          data-tv-group-container="album-retry"
          data-tv-group-kind="row"
          data-tv-group-order="20"
        >
          <p class={styles.tvErrorText}>{t('tv.library.detailError')}</p>
          <Control
            data-tv-id="album-retry-btn"
            data-tv-group="album-retry"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'album-retry-btn' ? 'true' : undefined}
            class={styles.tvSecondaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={() => void loadAlbum()}
          >
            {t('tv.retry')}
          </Control>
        </div>
      </Show>

      <Show when={rows().length > 0}>
        <TvVirtualList
          items={rows()}
          groupId="album-tracks"
          order={20}
          maxVisible={16}
          renderRow={(entry, index, tvId) => {
            const title = () =>
              entry.kind === 'local' ? entry.track.title : entry.item.title;
            const artist = () =>
              entry.kind === 'local'
                ? entry.track.artist
                : entry.item.artist || entry.item.subtitle || displayArtist();
            const duration = () =>
              entry.kind === 'local' ? entry.track.duration : entry.item.duration;
            const art = () =>
              entry.kind === 'local'
                ? trackCoverUrl(entry.track, 'thumb')
                : entry.resolved
                  ? trackCoverUrl(entry.resolved, 'thumb')
                  : safeExternalCover(entry.item.cover);
            const playing = () =>
              entry.kind === 'local'
                ? isPlayingTrack(entry.track)
                : Boolean(entry.resolved && isPlayingTrack(entry.resolved));

            return (
              <Control
                role="listitem"
                data-tv-id={tvId}
                data-tv-group="album-tracks"
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
                  src={art()}
                  alt={title()}
                  fallbackLabel={title()}
                />
                <div class={styles.tvTrackMain}>
                  <span class={styles.tvTrackTitle}>{title()}</span>
                  <span class={styles.tvTrackSub}>{artist()}</span>
                </div>
                <Show when={playing()}>
                  <span class={styles.tvPlayingBadge}>{t('tv.player.playingNow')}</span>
                </Show>
                <span class={styles.tvTrackDuration}>{formatDuration(duration())}</span>
              </Control>
            );
          }}
        />
      </Show>
    </>
  );
}
