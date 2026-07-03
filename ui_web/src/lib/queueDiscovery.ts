import type { SearchResult, Track } from '../types/music';

/**
 * Position of `track` in the queue, matching across sources: a library track
 * and its preview twin (same YouTube id) count as the same queue entry.
 * Returns -1 when absent.
 */
export function queueIndexOf(queue: Track[], track: Track): number {
  const yt = track.source === 'preview' ? track.id : track.youtube_id;
  return queue.findIndex(
    (t) =>
      t.id === track.id ||
      (!!yt && (t.id === yt || t.youtube_id === yt)) ||
      (!!track.id && t.youtube_id === track.id),
  );
}

/** Preview Track for an online result (streams via the preview endpoint). */
export function resultToTrack(result: SearchResult): Track {
  return {
    id: result.id,
    title: result.title,
    artist: result.channel ?? '',
    duration: result.duration,
    cover: result.thumbnail,
    source: 'preview',
  };
}

/** The library track an online result is already downloaded as, if any. */
export function libraryTrackFor(library: Track[], result: SearchResult): Track | null {
  return library.find((t) => t.youtube_id === result.id || t.id === result.id) ?? null;
}
