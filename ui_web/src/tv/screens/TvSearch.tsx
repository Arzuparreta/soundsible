import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { Control, InputControl } from '../../design/Control';
import { api } from '../../lib/api';
import { playCatalogItem } from '../../lib/catalogItem';
import { catalogTrack } from '../../lib/catalogTrack';
import { trackCount } from '../../lib/format';
import { t } from '../../lib/i18n';
import { filterLocalCollection, normalizeLibraryQuery, searchLibrary } from '../../lib/librarySearch';
import { trackCoverUrl } from '../../lib/media';
import { actions, isPlayingItem, isPlayingTrack, musicLibrary, state } from '../../stores';
import type { CatalogItem, Track } from '../../types/music';
import { TvCard } from '../components/TvCard';
import { TvTrackRow } from '../components/TvTrackRow';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { albumTvHash, playlistTvHash } from '../nav/router';
import {
  currentSearchGeneration,
  emptySearchResults,
  filterPlaylistsByQuery,
  nextSearchGeneration,
  searchQuery,
  searchResults,
  searchStatus,
  searchSubmittedQuery,
  setSearchQuery,
  setSearchResults,
  setSearchStatus,
  setSearchSubmittedQuery,
} from '../state';
import { albumCoverUrl, deriveAlbumsFromTracks, safeExternalCover } from '../tvLibraryHelpers';
import styles from '../styles/tv.module.css';

interface TvSearchProps {
  onNavigate: (hash: string) => void;
}

type SearchTrackRow =
  | { kind: 'local'; track: Track }
  | { kind: 'catalog'; item: CatalogItem; resolved: Track | null };

export function TvSearch(props: TvSearchProps) {
  const focus = useTvFocus();
  const [catalogPartialError, setCatalogPartialError] = createSignal(false);
  let abortActive: AbortController | null = null;

  onCleanup(() => {
    abortActive?.abort();
  });

  function localSearchMatches(q: string) {
    const query = normalizeLibraryQuery(q);
    const tracks = searchLibrary(musicLibrary(), [], q)
      .flatMap(result => result.kind === 'track' ? [result.track] : []);
    const albums = filterLocalCollection(deriveAlbumsFromTracks(musicLibrary()), query,
      album => [album.title, album.album_artist]);
    const playlists = filterPlaylistsByQuery(state.playlists, q);
    return { tracks, albums, playlists };
  }

  async function runSearch(rawQuery = searchQuery()): Promise<void> {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      abortActive?.abort();
      nextSearchGeneration();
      setSearchSubmittedQuery('');
      setSearchResults(emptySearchResults());
      setSearchStatus('idle');
      setCatalogPartialError(false);
      return;
    }

    abortActive?.abort();
    const ac = new AbortController();
    abortActive = ac;
    const gen = nextSearchGeneration();

    setSearchSubmittedQuery(trimmed);
    setSearchStatus('loading');
    setCatalogPartialError(false);

    const local = localSearchMatches(trimmed);
    setSearchResults({
      albums: local.albums,
      catalogAlbums: [],
      tracks: local.tracks,
      catalogTracks: [],
      playlists: local.playlists,
    });

    try {
      const catalog = await api.searchCatalog(trimmed, ac.signal);
      if (gen !== currentSearchGeneration()) return;

      const catalogAlbums = catalog.items.filter((item) => item.type === 'album');
      const catalogTracks = catalog.items.filter(
        (item) => item.type === 'track' || item.type === 'library_track',
      );
      setSearchResults({
        albums: local.albums,
        catalogAlbums,
        tracks: local.tracks,
        catalogTracks,
        playlists: local.playlists,
      });
      setSearchStatus('ready');
    } catch {
      if (gen !== currentSearchGeneration() || ac.signal.aborted) return;
      const hasLocal =
        local.albums.length > 0 || local.tracks.length > 0 || local.playlists.length > 0;
      setCatalogPartialError(true);
      setSearchStatus(hasLocal ? 'ready' : 'error');
    }
  }

  function clearSearch(): void {
    abortActive?.abort();
    nextSearchGeneration();
    setSearchQuery('');
    setSearchSubmittedQuery('');
    setSearchResults(emptySearchResults());
    setSearchStatus('idle');
    setCatalogPartialError(false);
  }

  const combinedTracks = createMemo<SearchTrackRow[]>(() => {
    const results = searchResults();
    const localIds = new Set(results.tracks.map((t) => t.id));
    const localRows: SearchTrackRow[] = results.tracks.map((track) => ({ kind: 'local', track }));
    const catalogRows: SearchTrackRow[] = results.catalogTracks
      .filter((item) => !item.track_id || !localIds.has(item.track_id))
      .map((item) => ({
        kind: 'catalog',
        item,
        resolved: catalogTrack(item, state.library),
      }));
    return [...localRows, ...catalogRows];
  });

  const hasAnyResults = createMemo(() => {
    const res = searchResults();
    return (
      res.albums.length > 0 ||
      res.catalogAlbums.length > 0 ||
      res.playlists.length > 0 ||
      combinedTracks().length > 0
    );
  });

  return (
    <>
      <header class={styles.tvHeaderBar}>
        <h1 class={styles.tvPageTitle}>{t('tv.nav.search')}</h1>
      </header>

      <form
        class={styles.tvRowGroup}
        data-tv-group-container="search-controls"
        data-tv-group-kind="row"
        data-tv-group-order="10"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <InputControl
          aria-label={t('tv.search.placeholder')}
          data-tv-id="search-input"
          data-tv-group="search-controls"
          data-tv-index="0"
          data-tv-focused={focus.activeId() === 'search-input' ? 'true' : undefined}
          class={styles.tvInput}
          classList={{ [styles.tvFocusTarget]: true }}
          type="search"
          placeholder={t('tv.search.placeholder')}
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
        <Control
          type="submit"
          data-tv-id="search-submit"
          data-tv-group="search-controls"
          data-tv-index="1"
          data-tv-focused={focus.activeId() === 'search-submit' ? 'true' : undefined}
          class={styles.tvPrimaryBtn}
          classList={{ [styles.tvFocusTarget]: true }}
        >
          {t('tv.search.submit')}
        </Control>
        <Show when={searchQuery().length > 0 || searchSubmittedQuery().length > 0}>
          <Control
            data-tv-id="search-clear"
            data-tv-group="search-controls"
            data-tv-index="2"
            data-tv-focused={focus.activeId() === 'search-clear' ? 'true' : undefined}
            class={styles.tvSecondaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={clearSearch}
          >
            {t('tv.search.clear')}
          </Control>
        </Show>
      </form>

      <Show when={searchStatus() === 'idle'}>
        <p class={styles.tvSubtitle}>{t('tv.search.emptyHint')}</p>
      </Show>

      <Show when={searchStatus() === 'loading'}>
        <p class={styles.tvSubtitle} role="status">{t('tv.search.loading')}</p>
      </Show>

      <Show when={searchStatus() === 'error' || (searchStatus() === 'ready' && catalogPartialError())}>
        <div
          class={styles.tvEmptyPanel}
          data-tv-group-container="search-error"
          data-tv-group-kind="row"
          data-tv-group-order="15"
        >
          <p class={styles.tvErrorText} role="alert">{t('tv.search.error')}</p>
          <Control
            data-tv-id="search-retry-btn"
            data-tv-group="search-error"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'search-retry-btn' ? 'true' : undefined}
            class={styles.tvSecondaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={() => void runSearch(searchSubmittedQuery() || searchQuery())}
          >
            {t('tv.retry')}
          </Control>
        </div>
      </Show>

      <Show when={searchStatus() === 'ready' && !hasAnyResults()}>
        <p class={styles.tvSubtitle}>
          {t('tv.search.noResults', { query: searchSubmittedQuery() })}
        </p>
      </Show>

      <Show when={searchResults().albums.length > 0 || searchResults().catalogAlbums.length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="search-albums-title">
          <h2 id="search-albums-title" class={styles.tvSectionTitle}>
            {t('tv.search.resultsAlbums')}
          </h2>
          <div
            class={styles.tvShelfRow}
            data-tv-scroll-x="search-albums"
            data-tv-group-container="search-albums"
            data-tv-group-kind="shelf"
            data-tv-group-order="20"
          >
            <For each={searchResults().albums}>
              {(album, idx) => {
                const tvId = () => `search-local-album-${idx()}`;
                return (
                  <TvCard
                    id={tvId()}
                    group="search-albums"
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
            <For each={searchResults().catalogAlbums}>
              {(item, idx) => {
                const overallIdx = () => searchResults().albums.length + idx();
                const tvId = () => `search-cat-album-${idx()}`;
                const deezerId =
                  typeof item.external_ids?.deezer === 'string'
                    ? item.external_ids.deezer
                    : typeof item.external_ids?.deezer === 'number'
                      ? String(item.external_ids.deezer)
                      : undefined;
                return (
                  <TvCard
                    id={tvId()}
                    group="search-albums"
                    index={overallIdx()}
                    title={item.title}
                    subtitle={item.artist || item.subtitle || t('tv.library.unknownArtist')}
                    artwork={safeExternalCover(item.cover)}
                    onActivate={() =>
                      props.onNavigate(
                        albumTvHash({
                          id: item.id,
                          name: item.title,
                          artist: item.artist || item.subtitle || '',
                          deezerId,
                        }),
                      )
                    }
                  />
                );
              }}
            </For>
          </div>
        </section>
      </Show>

      <Show when={searchResults().playlists.length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="search-playlists-title">
          <h2 id="search-playlists-title" class={styles.tvSectionTitle}>
            {t('tv.search.resultsPlaylists')}
          </h2>
          <div
            class={styles.tvRowGroup}
            data-tv-group-container="search-playlists"
            data-tv-group-kind="row"
            data-tv-group-order="25"
          >
            <For each={searchResults().playlists}>
              {(name, idx) => {
                const tvId = () => `search-playlist-${idx()}`;
                return (
                  <Control
                    data-tv-id={tvId()}
                    data-tv-group="search-playlists"
                    data-tv-index={String(idx())}
                    data-tv-focused={focus.activeId() === tvId() ? 'true' : undefined}
                    class={styles.tvSecondaryBtn}
                    classList={{ [styles.tvFocusTarget]: true }}
                    onClick={() => props.onNavigate(playlistTvHash(name))}
                  >
                    {name} · {trackCount(state.playlists[name]?.length ?? 0)}
                  </Control>
                );
              }}
            </For>
          </div>
        </section>
      </Show>

      <Show when={combinedTracks().length > 0}>
        <section class={styles.tvShelfSection} aria-labelledby="search-tracks-title">
          <h2 id="search-tracks-title" class={styles.tvSectionTitle}>
            {t('tv.search.resultsTracks')}
          </h2>
          <TvVirtualList
            items={combinedTracks()}
            groupId="search-tracks"
            order={30}
            renderRow={(row, index, tvId) => {
              const display = createMemo(() => {
                const value = row();
                if (value.kind === 'local') {
                  const track = value.track;
                  return { title: track.title, artist: track.artist, duration: track.duration,
                    artwork: trackCoverUrl(track, 'thumb'), playing: isPlayingTrack(track) };
                }
                const item = value.item;
                return {
                  title: item.title,
                  artist: item.artist || item.subtitle || '',
                  duration: item.duration,
                  artwork: value.resolved ? trackCoverUrl(value.resolved, 'thumb') : safeExternalCover(item.cover),
                  playing: isPlayingItem(value.item),
                };
              });

              return (
                <TvTrackRow
                  id={tvId()}
                  group="search-tracks"
                  index={index()}
                  title={display().title}
                  artist={display().artist}
                  artwork={display().artwork}
                  duration={display().duration}
                  playing={display().playing}
                  onActivate={() => {
                    const result = row();
                    if (result.kind === 'local') {
                      actions.playTrack(result.track);
                    } else {
                      void playCatalogItem(result.item);
                    }
                  }}
                />
              );
            }}
          />
        </section>
      </Show>
    </>
  );
}
