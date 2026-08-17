/**
 * One definition of "recently added", for a library that holds two kinds of song.
 *
 * A song you downloaded and a song you saved without downloading are both in
 * your library, and until the engine dated its tracks there was no way to
 * interleave them: the player faked recency by reversing a list built as
 * `[saves, files]`, which put every file above every save forever. A library
 * whose last download was days ago therefore opened on that download and stayed
 * there, however much music had been saved since.
 *
 * Both now carry `added_at` — a track from the engine's manifest, a saved entry
 * from `favourites.json` — so the two can simply be compared. This module is
 * where that comparison lives, so the songs tab, the Now Playing browser and
 * anything else that means "newest first" cannot drift apart.
 */

import type { Track } from '../types/music';

/**
 * A library date as a number, or `null` when the song has none.
 *
 * The engine writes naive UTC, and `Date.parse` reads an unzoned timestamp as
 * local time. That shifts every song by the same offset, which is invisible in
 * an ordering — and an ordering is all this is for. Nothing here should be
 * shown to anyone as a date.
 */
export function addedAtMs(track: Pick<Track, 'added_at'>): number | null {
  const raw = track.added_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Newest first, stable, without mutating the input.
 *
 * A song with no date sorts below every dated one and keeps its incoming
 * position. Callers therefore pass their best guess at newest-first order, and
 * an undated library comes out exactly as it went in — which is what a client
 * talking to an engine that has not been upgraded yet, or one whose files could
 * not be dated, should see: the previous behaviour, not noise.
 */
export function byRecency<T extends Pick<Track, 'added_at'>>(tracks: readonly T[]): T[] {
  return tracks
    .map((track, index) => ({ track, index, at: addedAtMs(track) }))
    .sort((a, b) => {
      if (a.at === null && b.at === null) return a.index - b.index;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at - a.at || a.index - b.index;
    })
    .map((row) => row.track);
}
