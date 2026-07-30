import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { actions, isPlayingTrack } from '../stores';
import { openTrackMenu } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import SongRow from './SongRow';
import { EmptyState } from './EmptyState';
import { artistPath } from '../lib/artistRoute';
import { coverBackground } from '../lib/cover';
import { coverUrl } from '../lib/media';
import { createResponsiveTap } from '../lib/responsiveTap';
import { t } from '../lib/i18n';
import type { LibrarySearchResult } from '../lib/librarySearch';
import styles from './LibrarySearchResults.module.css';
import { registerPrimaryScroll } from '../lib/scrollHistory';

/** Artwork for a row: the engine's file cover, or the snapshot's thumbnail for
 * a song we hold no file for. */
function trackCover(track: { id: string; cover?: string; source?: 'preview' }): string | undefined {
  return track.source === 'preview' ? track.cover : coverUrl(track.id);
}

function readRowHeight(): number {
  if (typeof document === 'undefined') return 60;
  return window.matchMedia('(min-width: 1024px)').matches ? 48 : 60;
}

function ArtistResult(props: { result: Extract<LibrarySearchResult, { kind: 'artist' }>; onOpen: () => void }) {
  const tap = createResponsiveTap({ onTap: props.onOpen });
  return (
    <div
      class={styles.artistRow}
      data-pressable
      role="button"
      tabindex="0"
      aria-label={t('library.openArtist', { artist: props.result.artist.name })}
      {...tap}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      <div
        class={styles.avatar}
        style={{ background: coverBackground(props.result.artist.name, coverUrl(props.result.artist.coverId)) }}
      />
      <div class={styles.artistMeta}>
        <span class={styles.artistName}>{props.result.artist.name}</span>
        <span class={styles.artistCount}>{t('library.artistTrackCount', { count: props.result.artist.count })}</span>
      </div>
      <span class={styles.badge}>{t('library.resultArtist')}</span>
      <svg class={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </div>
  );
}

export default function LibrarySearchResults(props: { results: LibrarySearchResult[] }) {
  let scrollRef: HTMLDivElement | undefined;
  const navigate = useNavigate();
  const [rowH, setRowH] = createSignal(readRowHeight());
  const trackQueue = createMemo(() =>
    props.results.flatMap((result) => result.kind === 'track' ? [result.track] : []),
  );
  const trackPositions = createMemo(() => {
    const positions = new Map<string, number>();
    trackQueue().forEach((track, index) => positions.set(track.id, index));
    return positions;
  });
  const openMenu = (track: Extract<LibrarySearchResult, { kind: 'track' }>['track'], event?: MouseEvent) =>
    openTrackMenu(
      track,
      {
        navigate,
        onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor,
        onPlayOnDevice: openPlayOnDevice,
      },
      event,
    );

  onMount(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setRowH(readRowHeight());
    sync();
    mq.addEventListener('change', sync);
    onCleanup(() => mq.removeEventListener('change', sync));
  });

  const virtualizer = createVirtualizer({
    get count() {
      return props.results.length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => rowH(),
    overscan: 10,
  });
  createEffect(on(rowH, () => virtualizer.measure(), { defer: true }));

  return (
    <div
      ref={(element) => {
        scrollRef = element;
        registerPrimaryScroll(element);
      }}
      class={styles.scroll}
      data-library-scroll
      data-primary-scroll
    >
      <Show when={props.results.length > 0} fallback={<EmptyState>{t('library.noSearchResults')}</EmptyState>}>
        <div class={styles.canvas} style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const result = () => props.results[item.index];
              return (
                <div
                  class={styles.slot}
                  style={{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }}
                >
                  <Show when={result()?.kind === 'track'}>
                    <SongRow
                      track={(result() as Extract<LibrarySearchResult, { kind: 'track' }>).track}
                      // A saved song with no file has no engine-side cover to
                      // ask for; its thumbnail is the only artwork it has.
                      cover={trackCover((result() as Extract<LibrarySearchResult, { kind: 'track' }>).track)}
                      badge={t('library.resultTrack')}
                      active={isPlayingTrack((result() as Extract<LibrarySearchResult, { kind: 'track' }>).track)}
                      onPlay={(track) => actions.playFrom(
                        trackQueue(),
                        trackPositions().get(track.id) ?? 0,
                        { context: { id: 'library-search', kind: 'search', label: t('library.searchLibrary') } },
                      )}
                      onMenu={openMenu}
                    />
                  </Show>
                  <Show when={result()?.kind === 'artist'}>
                    <ArtistResult
                      result={result() as Extract<LibrarySearchResult, { kind: 'artist' }>}
                      onOpen={() =>
                        navigate(
                          artistPath(
                            (result() as Extract<LibrarySearchResult, { kind: 'artist' }>).artist.name,
                            { view: 'library' },
                          ),
                        )
                      }
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
