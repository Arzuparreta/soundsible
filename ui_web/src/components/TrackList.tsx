import type { MenuEvent } from '../lib/menuEvent';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { Show, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { isPlayingTrack } from '../stores';
import { player } from '../stores/player';
import SongRow from './SongRow';
import { CollectionRows } from './CollectionView';
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
  const openMenu = (track: Track, ev?: MenuEvent) =>
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
          {/* The slot outlives the track it shows (see CollectionRows), so
              everything a row needs is read through the accessors. */}
          <CollectionRows items={props.tracks} scrollElement={() => scrollRef ?? null}>
            {(track, index) => (
              <SongRow
                track={track()}
                favouritesKnown={props.context?.kind === 'favourites'}
                cover={trackCoverUrl(track(), 'thumb')}
                favouritable={!isPodcastTrack(track())}
                active={isPlayingTrack(track())}
                onPlay={() =>
                  props.onPlay
                    ? props.onPlay(props.tracks, index())
                    : player().actions.playFrom(props.tracks, index(), { context: props.context })
                }
                music={libraryTrackMusic(track())}
                onMenu={openMenu}
              />
            )}
          </CollectionRows>
        </Show>
      </Show>
    </div>
  );
}
