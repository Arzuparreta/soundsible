import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { BackIcon, PlayFilledIcon } from '../../components/icons';
import { EntityIdentity } from '../../design/EntityIdentity';
import { Control } from '../../design/Control';
import { api } from '../../lib/api';
import { playCatalogItem } from '../../lib/catalogItem';
import { catalogTrack } from '../../lib/catalogTrack';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { coverUrl, trackCoverUrl } from '../../lib/media';
import type { PlaybackContextDescriptor } from '../../lib/playbackQueue';
import { actions, isPlayingItem, isPlayingTrack, musicLibrary, state } from '../../stores';
import type { CatalogAlbum, CatalogItem, Track } from '../../types/music';
import { TvArtwork } from '../components/TvArtwork';
import { TvTrackRow } from '../components/TvTrackRow';
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
  source?: 'library' | 'catalog';
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

  const isCatalog = () => props.source === 'catalog' || Boolean(props.deezerId);

  let loadGen = 0;

  async function loadAlbum(signal?: AbortSignal): Promise<void> {
    const gen = ++loadGen;

    setLoading(true);
    setError(false);
    setAlbum(null);
    setTrackIds([]);
    setCatalogTracks([]);
    setExternalCover(undefined);

    if (!isCatalog() && !props.albumId.includes('::')) {
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
    void props.source;
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

  const useCatalogRows = createMemo(
    () => catalogTracks().length > 0 && (isCatalog() || localTracks().length === 0),
  );

  function playAt(index: number): void {
    if (useCatalogRows()) {
      const items = catalogTracks();
      const chosen = items[index];
      if (chosen) {
        void playCatalogItem(chosen, items, contextDescriptor());
      }
      return;
    }
    if (isCatalog() && loading()) return;
    const locals = localTracks();
    if (locals.length > 0) {
      actions.playFrom(locals, index, { context: contextDescriptor() });
    }
  }

  const rows = createMemo<AlbumRow[]>(() => {
    if (useCatalogRows()) {
      return catalogTracks().map((item): AlbumRow => ({
        kind: 'catalog',
        item,
        resolved: catalogTrack(item, state.library),
      }));
    }
    if (isCatalog() && loading()) return [];
    return localTracks().map((track): AlbumRow => ({ kind: 'local', track }));
  });

  return (
    <>
      <section class={styles.tvDetailHero}>
        <TvArtwork
          class={styles.tvDetailArt}
          src={externalCover()}
          alt={displayTitle()}
          fallbackLabel={displayTitle()}
        />
        <div class={styles.tvDetailInfo}>
          <span class={styles.tvEyebrow}>{t('nowPlaying.contextKind.album')}</span>
          <EntityIdentity
            class={styles.tvIdentityText}
            headingClass={styles.tvHeroTitle}
            title={displayTitle()}
            metadata={<p class={styles.tvSubtitle}>
              {displayArtist()} · {trackCount(rows().length)}
            </p>}
          />
          <div
            class={styles.tvRowGroup}
            data-tv-group-container="album-actions"
            data-tv-group-kind="row"
            data-tv-group-order="10"
          >
            <Show when={rows().length > 0}>
              <Control
                data-tv-id="album-play-btn"
                data-tv-group="album-actions"
                data-tv-index="0"
                data-tv-focused={focus.activeId() === 'album-play-btn' ? 'true' : undefined}
                class={styles.tvPrimaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                onClick={() => playAt(0)}
              >
                <PlayFilledIcon /> {t('tv.library.playAll')}
              </Control>
            </Show>
            <Control
              data-tv-id="album-back-btn"
              data-tv-group="album-actions"
              data-tv-index="1"
              data-tv-focused={focus.activeId() === 'album-back-btn' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={props.onBack}
            >
              <BackIcon /> {t('tv.back')}
            </Control>
          </div>
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
          renderRow={(entry, index, tvId) => {
            const display = createMemo(() => {
              const value = entry();
              if (value.kind === 'local') {
                const track = value.track;
                return { title: track.title, artist: track.artist, duration: track.duration,
                  artwork: trackCoverUrl(track, 'thumb'), playing: isPlayingTrack(track) };
              }
              const item = value.item;
              return {
                title: item.title,
                artist: item.artist || item.subtitle || displayArtist(),
                duration: item.duration,
                artwork: value.resolved ? trackCoverUrl(value.resolved, 'thumb') : safeExternalCover(item.cover),
                playing: isPlayingItem(item) || Boolean(value.resolved && isPlayingTrack(value.resolved)),
              };
            });

            return (
              <TvTrackRow
                id={tvId()}
                group="album-tracks"
                index={index()}
                title={display().title}
                artist={display().artist}
                artwork={display().artwork}
                duration={display().duration}
                playing={display().playing}
                onActivate={() => playAt(index())}
              />
            );
          }}
        />
      </Show>
    </>
  );
}
