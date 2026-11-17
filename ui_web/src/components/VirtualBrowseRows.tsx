import type { MenuEvent } from '../lib/menuEvent';
import { createSignal } from 'solid-js';
import { CollectionRows } from './CollectionView';
import { MusicListRowView } from './MusicListRowView';
import { programTrack } from '../lib/program/tracks';
import { trackCoverUrl } from '../lib/media';
import type { Track } from '../types/music';

/** Read-only use of the shared song row: bounded DOM even for a full home library. */
export function VirtualBrowseRows(props: { tracks: Track[]; onPlay?: (index: number) => void; activeId?: string; isActive?: (track: Track) => boolean; onMenu?: (track: Track, event?: MenuEvent, index?: number) => void; offline?: boolean; favourite?: (track: Track) => boolean }) {
  const [scroll, setScroll] = createSignal<HTMLDivElement | null>(null);
  return <div ref={setScroll} style={{ height: 'max(240px, calc(100dvh - 320px))', overflow: 'auto' }} data-library-scroll>
    <CollectionRows items={props.tracks} scrollElement={scroll}>
      {(track, index) => <div data-browse-track-id={track().id}>
        <MusicListRowView title={track().title} subtitle={track().artist}
          favourite={props.favourite?.(track())} seed={track().id} cover={props.offline ? undefined : trackCoverUrl(track(), 'thumb')} disabled={!props.onPlay || !programTrack(track())}
          onMenu={props.onMenu ? event => props.onMenu?.(track(), event, index()) : undefined}
          active={props.isActive ? props.isActive(track()) : props.activeId === track().id} playback onActivate={() => props.onPlay?.(index())} />
      </div>}
    </CollectionRows>
  </div>;
}
