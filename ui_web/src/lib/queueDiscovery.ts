import type { SearchResult, Track } from '../types/music';

/** Canonical playback identity shared by queue/discovery features. A downloaded
 * track and its online preview must be treated as the same song. */
export function queueIdentity(track: Track): string {
  return track.youtube_id || track.id;
}

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

/** Who an online result is by. The server reads the performer out of the
 * upload ("Artist - Song", "Artist - Topic", "Artist (Oficial)"); a row it could
 * not read, or one cached before it did, is credited to its channel. */
export function resultCredit(result: SearchResult): Pick<Track, 'artist' | 'artist_is_channel'> {
  return result.artist
    ? { artist: result.artist, artist_is_channel: result.artist_is_channel ?? true }
    : { artist: result.channel ?? '', artist_is_channel: true };
}
