import { CollectionSearch, NoCollectionMatches, createCollectionSearch } from './CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import { createEffect, For, on, Show } from 'solid-js';
import { player } from '../stores/player';
import { libraryTrackMusic } from '../lib/musicNavigation';
import { trackCoverUrl } from '../lib/media';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import type { Track } from '../types/music';
import SongRow from './SongRow';
import { CollectionRows } from './CollectionView';

/** Up to this many rows the list is built whole. Measured on the rendering
 * bench: a list this short costs less to build once than to keep bounded, and
 * it then scrolls without running any script. Most albums are under it. */
const WHOLE_LIST_ROWS = 60;

/**
 * The numbered songs of an album or an artist, under the page's header and in
 * the page's own scrollport. A long one is bounded like every other song
 * list: an artist with a thousand songs renders the rows on screen, not a
 * thousand.
 */
export function EntityTrackList(props: { tracks: Track[]; context: PlaybackContextDescriptor }) {
  const search = createCollectionSearch();
  const tracks = search.filter(() => props.tracks, trackSearchFields);
  const position = search.positions(() => props.tracks);
  createEffect(on(() => props.context.id, () => search.setValue(''), { defer: true }));
  const row = (track: () => Track, index: () => number) => (
    <SongRow
      track={track()} music={libraryTrackMusic(track())}
      index={position(track())}
      cover={trackCoverUrl(track(), 'thumb')}
      onPlay={() => player().actions.playFrom(tracks(), index(), { context: props.context })}
    />
  );
  return <>
    <CollectionSearch search={search} />
    <Show when={tracks().length} fallback={<NoCollectionMatches />}>
      <Show when={tracks().length > WHOLE_LIST_ROWS} fallback={<For each={tracks()}>{(track, index) => row(() => track, index)}</For>}>
        <CollectionRows items={tracks()}>{row}</CollectionRows>
      </Show>
    </Show>
  </>;
}
