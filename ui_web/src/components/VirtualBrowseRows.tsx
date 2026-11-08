import { createRowHeight } from '../lib/rowHeight';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { createEffect, on, For, Show } from 'solid-js';
import { MusicListRowView } from './MusicListRowView';
import { programTrack } from '../lib/program/tracks';
import { trackCoverUrl } from '../lib/media';
import type { Track } from '../types/music';

/** Read-only use of the shared song row: bounded DOM even for a full home library. */
export function VirtualBrowseRows(props: { tracks: Track[]; onPlay?: (index: number) => void; activeId?: string; isActive?: (track: Track) => boolean; onMenu?: (track: Track, event?: MouseEvent, index?: number) => void; offline?: boolean; favourite?: (track: Track) => boolean }) {
  let scroll!: HTMLDivElement;
  const height = createRowHeight();
  const rows = createVirtualizer({
    get count() { return props.tracks.length; },
    getScrollElement: () => scroll,
    estimateSize: () => height(),
    overscan: 10,
  });
  createEffect(on(height, () => rows.measure(), { defer: true }));
  return <div ref={scroll} style={{ height: 'max(240px, calc(100dvh - 320px))', overflow: 'auto' }} data-library-scroll>
    <div style={{ height: `${rows.getTotalSize()}px`, position: 'relative' }}>
      <For each={rows.getVirtualItems()}>{item => <div data-browse-track-id={props.tracks[item.index]?.id} style={{ position: 'absolute', width: '100%', top: '0', transform: `translateY(${item.start}px)` }}>
        <Show when={props.tracks[item.index]}>{track => <MusicListRowView title={track().title} subtitle={track().artist}
          favourite={props.favourite?.(track())} seed={track().id} cover={props.offline ? undefined : trackCoverUrl(track(), 'thumb')} disabled={!props.onPlay || !programTrack(track())}
          onMenu={props.onMenu ? event => props.onMenu?.(track(), event, item.index) : undefined}
          active={props.isActive ? props.isActive(track()) : props.activeId === track().id} playback onActivate={() => props.onPlay?.(item.index)} />}</Show>
      </div>}</For>
    </div>
  </div>;
}
