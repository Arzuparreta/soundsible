import { createEffect, createSignal, For, Show, on, onCleanup, onMount, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { actions, isPlayingTrack, state } from '../stores';
import SongRow from './SongRow';
import { openTrackMenu, type TrackMenuContext } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { coverUrl } from '../lib/media';
import { artistPath } from '../lib/artistRoute';
import { isPodcastTrack } from '../lib/track';
import { t as tr } from '../lib/i18n';
import type { Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import styles from './TrackList.module.css';
import { SkeletonRows } from './Skeleton';
import { EmptyState } from './EmptyState';

/** Current value of the `--row-h` design token, in pixels. Falls back to the
 * mobile default when the stylesheet has not applied yet (SSR, tests). */
function readRowHeight(): number {
  if (typeof document === 'undefined') return 56;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 56;
}

/**
 * Reusable virtualized song list. Shared by Library, Favourites and Search.
 * Reads playback/favourites/actions from the single store; only visible rows
 * render, and only the affected node updates on play/favourite changes.
 *
 * `menu` lets a view extend the row's context menu (e.g. a playlist passes
 * `playlistName` + `onRemoveFromPlaylist`); `navigate` is always wired here.
 */
export default function TrackList(props: {
  tracks: Track[];
  loading?: boolean;
  empty?: JSX.Element;
  menu?: Partial<TrackMenuContext>;
  context?: PlaybackContextDescriptor;
  /** When false, the artist name is rendered as plain text so tapping it
   * bubbles to the row and plays the track instead of navigating. Useful on
   * mobile, where tapping the subtitle is the same gesture as tapping the row. */
  linkArtist?: boolean;
  /** Override how a row starts playback. Defaults to `actions.playFrom` over
   * the whole list; Favourites uses it to resolve a saved song that has no
   * source attached yet before handing it to the queue. */
  onPlay?: (tracks: Track[], index: number) => void;
}) {
  let scrollRef: HTMLDivElement | undefined;
  const navigate = useNavigate();
  const goArtist = (artist: string) => artist && navigate(artistPath(artist, { view: 'library' }));
  const openMenu = (track: Track, ev?: MouseEvent) =>
    openTrackMenu(
      track,
      {
        navigate,
        onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor,
        onPlayOnDevice: openPlayOnDevice,
        ...props.menu,
      },
      ev,
    );

  // Row height follows the adaptive --row-h token (56 mobile / 44 desktop).
  // It has to be re-read when the viewport crosses that breakpoint — rotating a
  // phone or dragging a desktop window narrow changes the token, and a
  // virtualizer still positioning rows 56px apart inside 44px slots leaves the
  // list visibly gapped (or overlapping, the other way round).
  const [rowH, setRowH] = createSignal(readRowHeight());
  onMount(() => {
    const syncRowHeight = () => setRowH(readRowHeight());
    syncRowHeight();
    const mq = window.matchMedia('(min-width: 1024px)');
    mq.addEventListener('change', syncRowHeight);
    window.addEventListener('orientationchange', syncRowHeight);
    onCleanup(() => {
      mq.removeEventListener('change', syncRowHeight);
      window.removeEventListener('orientationchange', syncRowHeight);
    });
  });

  // Changing accessibility size updates CSS custom properties without crossing
  // a media-query boundary. Read the reactive preference, then re-read the
  // computed token after the root data attribute has been applied.
  createEffect(() => {
    void state.interfaceSize;
    queueMicrotask(() => setRowH(readRowHeight()));
  });

  const virtualizer = createVirtualizer({
    get count() {
      return props.tracks.length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => rowH(),
    overscan: 10,
  });

  // `estimateSize` is only consulted when the virtualizer measures, so a new
  // row height has to ask for a re-measure explicitly.
  createEffect(on(rowH, () => virtualizer.measure(), { defer: true }));

  return (
    <div ref={scrollRef} class={styles.scroll} data-library-scroll data-primary-scroll>
      <Show
        when={!(props.loading && props.tracks.length === 0)}
        fallback={<SkeletonRows count={10} />}
      >
        <Show
          when={props.tracks.length > 0}
          fallback={props.empty ?? <EmptyState>{tr('trackList.defaultEmpty')}</EmptyState>}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            <For each={virtualizer.getVirtualItems()}>
              {(vi) => {
                // The row's content must be *read* reactively, not captured.
                // The virtualizer reconciles its items by index, so a slot that
                // stays on screen keeps the exact same `{index, start, size}` —
                // and therefore the same row component — when the list behind it
                // changes. Reading `props.tracks[vi.index]` once froze whatever
                // was there at creation: a finished download prepended a track
                // to the library and every visible row kept rendering the old
                // one until the view was remounted. As an accessor, the row
                // follows the list instead, and a shrinking list (a deleted
                // track) empties its slot rather than rendering a hole.
                const track = () => props.tracks[vi.index] as Track | undefined;
                return (
                  <Show when={track()}>
                    {(t) => (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${vi.size}px`,
                          transform: `translateY(${vi.start}px)`,
                        }}
                      >
                        <SongRow
                          track={t()}
                          // A preview's artwork is the thumbnail it carries;
                          // asking the engine for a cover it has no file for
                          // just 404s into the placeholder gradient.
                          cover={t().source === 'preview' ? t().cover : coverUrl(t().id)}
                          favouritable={!isPodcastTrack(t())}
                          active={isPlayingTrack(t())}
                          onPlay={() =>
                            props.onPlay
                              ? props.onPlay(props.tracks, vi.index)
                              : actions.playFrom(props.tracks, vi.index, { context: props.context })
                          }
                          onArtist={props.linkArtist === false ? undefined : goArtist}
                          onMenu={openMenu}
                        />
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
