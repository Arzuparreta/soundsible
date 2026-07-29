import type { CatalogItem, SavedEntry, SearchResult, Track } from '../types/music';
import { catalogItemKeys, searchResultKeys, trackKeys } from './playbackIdentity';

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
  extra: { album?: string; duration?: number; thumbnail?: string },
): SavedEntry => {
  const entry: SavedEntry = { keys, title, artist };
  if (extra.album) entry.album = extra.album;
  if (typeof extra.duration === 'number' && Number.isFinite(extra.duration) && extra.duration > 0)
    entry.duration = Math.round(extra.duration);
  if (extra.thumbnail) entry.thumbnail = extra.thumbnail;
  return entry;
};

/** An entry for a playable track — library or preview alike. */
export function savedFromTrack(track: Track): SavedEntry {
  return snapshot(trackKeys(track), track.title, track.artist, {
    album: track.album,
    duration: track.duration,
    // A library track's art comes from the engine and needs no snapshot; a
    // preview's thumbnail is the only artwork it will ever have.
    thumbnail: track.source === 'preview' ? track.cover : undefined,
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
  });
}

/** An entry for an online (YouTube) search result. */
export function savedFromSearchResult(result: SearchResult): SavedEntry {
  return snapshot(searchResultKeys(result), result.title, result.channel ?? '', {
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
    duration: entry.duration,
    cover: entry.thumbnail,
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
