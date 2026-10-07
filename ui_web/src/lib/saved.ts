import type { CatalogItem, SavedEntry, SearchResult, Track } from '../types/music';
import { catalogItemKeys, searchResultKeys, trackKeys } from './playbackIdentity';
import { resultCredit } from './queueDiscovery';
import { releasePosition } from './catalogTrack';

/**
 * Your collection: every song you have claimed, downloaded or not.
 *
 * Saving a song records **what it is** (its identity keys) plus **what it looks
 * like** (a small snapshot), never where its bytes happen to live. That single
 * choice is what lets one library hold both:
 *
 * - Nothing local is required to render or play a saved song. The snapshot
 *   rebuilds a `source: 'preview'` track, which streams through
 *   `/api/preview/stream/<video_id>` exactly like any Discover row.
 * - Downloading is a separate act with no bookkeeping. The entry is resolved
 *   against the library *at read time*, so the moment a download lands, the
 *   same entry starts answering with the owned track — local audio, real cover,
 *   editable, deletable. Nothing is rewritten and no order is disturbed.
 *
 * The inverse holds too: delete the file and the song degrades back to a
 * stream instead of vanishing. You freed disk — you did not lose the song.
 *
 * `favourite` is a mark laid over all of this, never a way of holding a song.
 * See `stores/index.ts` for the two rules that connect them: marking an unsaved
 * song saves it, and unsaving drops the mark with it.
 */

/** The YouTube video id an entry can be streamed with, if it has one yet. */
export function savedVideoId(entry: SavedEntry): string | null {
  const key = entry.keys.find((k) => k.startsWith('yt:'));
  return key ? key.slice(3) : null;
}

/** The library track id an entry claims to be, if any. Prefer resolving through
 * the identity index — this is for the rare caller that only speaks ids. */
export function savedLibraryId(entry: SavedEntry): string | null {
  const key = entry.keys.find((k) => k.startsWith('lib:'));
  return key ? key.slice(4) : null;
}

const snapshot = (
  keys: string[],
  title: string,
  artist: string,
  extra: {
    album?: string; duration?: number; thumbnail?: string;
    album_artist?: string | null; track_number?: number | null; disc_number?: number | null; year?: number | null;
  },
): SavedEntry => {
  const entry: SavedEntry = { keys, title, artist };
  if (extra.album) entry.album = extra.album;
  if (extra.album_artist) entry.album_artist = extra.album_artist;
  // Bounded as the engine bounds them; anything else would be dropped there.
  const whole = (value: number | null | undefined, low: number, high: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : undefined;
  const trackNumber = whole(extra.track_number, 1, 999), discNumber = whole(extra.disc_number, 1, 99), year = whole(extra.year, 1000, 9999);
  if (trackNumber) entry.track_number = trackNumber;
  if (discNumber) entry.disc_number = discNumber;
  if (year) entry.year = year;
  if (typeof extra.duration === 'number' && Number.isFinite(extra.duration) && extra.duration > 0)
    entry.duration = Math.round(extra.duration);
  if (extra.thumbnail) entry.thumbnail = extra.thumbnail;
  return entry;
};

/** An entry for a playable track — library or preview alike. */
export function savedFromTrack(track: Track): SavedEntry {
  const preview = track.source === 'preview';
  return snapshot(trackKeys(track), track.title, track.artist, {
    album: track.album,
    duration: track.duration,
    // A library track's art and tags come from the engine and need no
    // snapshot; a preview's are the only ones it will have until downloaded.
    thumbnail: preview ? track.cover : undefined,
    ...(preview ? { album_artist: track.album_artist, track_number: track.track_number, disc_number: track.disc_number, year: track.year } : {}),
  });
}

/** An entry for a catalog row (Deezer, MusicBrainz, YouTube, library).
 *
 * The artist fallback mirrors `itemArtist` in `lib/catalogItem.ts`; it is
 * repeated rather than imported to keep this module a leaf (importing it would
 * close a cycle back through the store, and these builders have to stay
 * testable on their own). */
export function savedFromCatalogItem(item: CatalogItem): SavedEntry {
  return snapshot(catalogItemKeys(item), item.title, item.artist || item.subtitle || '', {
    album: item.album,
    duration: item.duration,
    thumbnail: item.cover,
    album_artist: typeof item.raw?.album_artist === 'string' ? item.raw.album_artist : undefined,
    ...releasePosition(item),
  });
}

/** An entry for an online (YouTube) search result. */
export function savedFromSearchResult(result: SearchResult): SavedEntry {
  return snapshot(searchResultKeys(result), result.title, resultCredit(result).artist, {
    duration: result.duration,
    thumbnail: result.thumbnail,
  });
}

/**
 * The playable track behind a saved song — the one place the "downloaded or
 * not" rule lives.
 *
 * Returns `null` only when the entry is genuinely unusable: no library match and
 * no title to show. That happens to pre-v2 entries whose track was deleted —
 * an id pointing at nothing, with nothing to say about itself.
 */
export function savedToTrack(
  entry: SavedEntry,
  libraryIndex: ReadonlyMap<string, Track>,
): Track | null {
  for (const key of entry.keys) {
    const owned = libraryIndex.get(key);
    if (owned) return owned;
  }

  if (!entry.title) return null;

  const videoId = savedVideoId(entry);
  return {
    // Without a video id the entry is still being resolved server-side; keep it
    // visible (it is a real saved song) but give it an id nothing will mistake
    // for a stream. `savedIsPlayable` is how callers tell the difference.
    id: videoId ?? entry.keys[0],
    title: entry.title,
    artist: entry.artist ?? '',
    album: entry.album,
    album_artist: entry.album_artist,
    track_number: entry.track_number,
    disc_number: entry.disc_number,
    year: entry.year,
    duration: entry.duration,
    cover: entry.thumbnail,
    // The day you claimed the song, carried onto the track so a save and a
    // download can be ordered against each other at all.
    added_at: entry.added_at ?? null,
    source: 'preview',
    // Carry the saved identity, so the Deezer/search row this came from still
    // recognises itself as playing once the preview starts.
    originKeys: entry.keys,
  };
}

/** Can this saved song actually be streamed right now? False while a catalog
 * row saved without ever being played is still waiting on its server-side
 * resolve. */
export function savedIsPlayable(entry: SavedEntry, track: Track): boolean {
  return track.source !== 'preview' || savedVideoId(entry) !== null;
}
