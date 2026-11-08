import { createRowHeight } from '../lib/rowHeight';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { createEffect, For, Show, on, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { actions, isPlayingTrack } from '../stores';
import SongRow from './SongRow';
import { openTrackMenu, type TrackMenuContext } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { trackCoverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { t as tr } from '../lib/i18n';
import type { Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import styles from './TrackList.module.css';
import { SkeletonRows } from './Skeleton';
import { EmptyState } from './EmptyState';
import { registerPrimaryScroll } from '../lib/scrollHistory';

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
  /** Override how a row starts playback. Defaults to `actions.playFrom` over
   * the whole list; Favourites uses it to resolve a saved song that has no
   * source attached yet before handing it to the queue. */
  onPlay?: (tracks: Track[], index: number) => void;
}) {
  let scrollRef: HTMLDivElement | undefined;
  const navigate = useNavigate();
  const openMenu = (track: Track, ev?: MouseEvent) =>
    openTrackMenu(
      track,
      {
        navigate,
        music: libraryTrackMusic(track),
        onAddToPlaylist: openPlaylistPicker,
        onEditMetadata: openMetadataEditor,
        onPlayOnDevice: openPlayOnDevice,
        ...props.menu,
      },
      ev,
    );

  const rowH = createRowHeight();

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
    <div
      ref={(element) => {
        scrollRef = element;
        registerPrimaryScroll(element, () => !props.loading || props.tracks.length > 0);
      }}
      class={styles.scroll}
      data-library-scroll
      data-primary-scroll
    >
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
                          favouritesKnown={props.context?.kind === 'favourites'}
                          cover={trackCoverUrl(t(), 'thumb')}
                          favouritable={!isPodcastTrack(t())}
                          active={isPlayingTrack(t())}
                          onPlay={() =>
                            props.onPlay
                              ? props.onPlay(props.tracks, vi.index)
                              : actions.playFrom(props.tracks, vi.index, { context: props.context })
                          }
                          music={libraryTrackMusic(track()!)}
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
