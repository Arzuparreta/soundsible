import { createEffect, createSignal, For, Show, on, onCleanup, onMount, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { actions, isPlayingTrack } from '../stores';
import SongRow from './SongRow';
import { openTrackMenu, type TrackMenuContext } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import { openMetadataEditor } from './MetadataEditor';
import { openPlayOnDevice } from './DeviceSheet';
import { coverUrl } from '../lib/media';
import { artistPath } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './TrackList.module.css';
import { SkeletonRows } from './Skeleton';
import { EmptyState } from './EmptyState';

/** Current value of the `--row-h` design token, in pixels. Falls back to the
 * mobile default when the stylesheet has not applied yet (SSR, tests). */
function readRowHeight(): number {
  if (typeof document === 'undefined') return 56;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 56;
}

/**
 * Reusable virtualized song list. Shared by Home, Favourites and Search.
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
  /** When false, the artist name is rendered as plain text so tapping it
   * bubbles to the row and plays the track instead of navigating. Useful on
   * mobile, where tapping the subtitle is the same gesture as tapping the row. */
  linkArtist?: boolean;
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
    setRowH(readRowHeight());
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setRowH(readRowHeight());
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
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
    <div ref={scrollRef} class={styles.scroll}>
      <Show
        when={!(props.loading && props.tracks.length === 0)}
        fallback={<SkeletonRows count={10} />}
      >
        <Show
          when={props.tracks.length > 0}
          fallback={props.empty ?? <EmptyState>{t('trackList.defaultEmpty')}</EmptyState>}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            <For each={virtualizer.getVirtualItems()}>
              {(vi) => {
                const track = props.tracks[vi.index];
                return (
                  <Show when={track}>
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
                        track={track!}
                        cover={coverUrl(track!.id)}
                        active={isPlayingTrack(track!)}
                        onPlay={() => actions.playFrom(props.tracks, vi.index)}
                        onArtist={props.linkArtist === false ? undefined : goArtist}
                        onMenu={openMenu}
                      />
                    </div>
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
