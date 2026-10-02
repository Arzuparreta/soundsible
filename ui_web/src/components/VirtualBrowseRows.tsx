import { createVirtualizer } from '@tanstack/solid-virtual';
import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { MusicListRowView } from './MusicListRowView';
import { trackCoverUrl } from '../lib/media';
import type { Track } from '../types/music';

/** Read-only use of the shared song row: bounded DOM even for a full home library. */
export function VirtualBrowseRows(props: { tracks: Track[]; onPlay?: (index: number) => void; activeId?: string }) {
  let scroll!: HTMLDivElement;
  const [height, setHeight] = createSignal(56);
  const rows = createVirtualizer({
    get count() { return props.tracks.length; },
    getScrollElement: () => scroll,
    estimateSize: () => height(),
    overscan: 10,
  });
  onMount(() => {
    const measure = () => {
      setHeight(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 56);
      rows.measure();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll); measure();
    onCleanup(() => observer.disconnect());
  });
  return <div ref={scroll} style={{ height: 'max(240px, calc(100dvh - 320px))', overflow: 'auto' }} data-library-scroll>
    <div style={{ height: `${rows.getTotalSize()}px`, position: 'relative' }}>
      <For each={rows.getVirtualItems()}>{item => <div style={{ position: 'absolute', width: '100%', top: '0', transform: `translateY(${item.start}px)` }}>
        <Show when={props.tracks[item.index]}>{track => <MusicListRowView title={track().title} subtitle={track().artist}
          seed={track().id} cover={trackCoverUrl(track(), 'thumb')} disabled={!props.onPlay || track().source === 'preview'}
          active={props.activeId === track().id} playback onActivate={() => props.onPlay?.(item.index)} />}</Show>
      </div>}</For>
    </div>
  </div>;
}
