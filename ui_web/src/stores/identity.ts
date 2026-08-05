/**
 * One definition of "this is the thing that is playing", and everything derived
 * from it: queued, saved, favourited, owned, downloading.
 *
 * A song has several names — a library id, a video id, an ISRC, a catalog row
 * — and the same song can arrive under any of them. Matching on one id meant a
 * Deezer row and the file it produced looked like different songs. These
 * selectors compare key *sets* instead, and are memoized inside a `createRoot`
 * so a library refresh rebuilds the index once rather than per consumer.
 */

import { createMemo, createRoot, createSignal } from 'solid-js';

import { state } from './core';
import {
  buildIdentityIndex,
  catalogItemKeys,
  collectIdentityKeys,
  keysMatch,
  podcastEpisodeKeys,
  resolvePlayingKeys,
  searchResultKeys,
  trackKeys,
  withLinkedKeys,
} from '../lib/playbackIdentity';
import { savedToTrack } from '../lib/saved';
import { isMusicTrack } from '../lib/track';
import { futureEntries } from '../lib/playbackQueue';
import type { CatalogItem, SavedEntry, SearchResult, Track } from '../types/music';

/** A saved song and the track it currently resolves to. */
export interface SavedRow {
  entry: SavedEntry;
  track: Track;
}

/**
 * The music library: every song you have, downloaded or streaming, podcast
 * episodes excluded. Reactive: call inside a tracking scope (e.g. createMemo).
 *
 * Every music browse surface (Library, Artist, Album) reads this rather than
 * `state.library`, so a song you saved without downloading is browsable exactly
 * like one you own the file for — which is the whole point of saving it.
 * Surfaces that genuinely mean "files on disk" (the downloader's duplicate
 * check, the metadata editor) keep reading `state.library` directly.
 */
export function musicLibrary(): Track[] {
  return identity.libraryTracks();
}


/* ── Playback identity ──
 *
 * One definition of "this is the thing that is playing", shared by every
 * surface. See `lib/playbackIdentity.ts` for why identity is a set of keys and
 * not an id.
 *
 * Two derived values, and nothing else moves:
 *
 * - `libraryIndex` maps every key the library answers to → its track. Rebuilt
 *   only when `state.library` actually changes.
 * - `playingKeys` is the current track's keys *plus* the keys of its library
 *   twin, looked up through that index.
 *
 * That second union is what closes the download case. Finishing a download
 * emits `downloader_update`, which already calls `syncLibrary()`; the new
 * library array invalidates `libraryIndex`, which invalidates `playingKeys`,
 * which now contains the freshly minted `lib:` id — and the row in the library
 * lights up on its own. Socket event → store write → memo → one class toggle.
 * No polling, no extra request, no timer.
 */

/** Catalog row id → YouTube video id, learned when a row is resolved or saved.
 * The engine's search response cannot know this (the resolution happens after
 * the search), so a Deezer row you just downloaded would otherwise keep
 * offering "＋ add" until the query was run again. */
export const [catalogLinks, setCatalogLinks] = createSignal<ReadonlyMap<string, string>>(new Map());

export const identity = createRoot(() => {
  const libraryIndex = createMemo(() => buildIdentityIndex(state.library));
  const playingKeys = createMemo(() =>
    resolvePlayingKeys(state.playback.currentTrack, libraryIndex(), catalogLinks()),
  );
  // Queue membership has the same identity problem as the playing highlight: a
  // Deezer row already lined up must say so, whatever id the row holds.
  const queuedKeys = createMemo(() =>
    collectIdentityKeys(futureEntries(state.playback.queue, state.playback.index, 'manual')),
  );
  // Saved songs have the same identity problem, one hop further out: the row
  // you saved in Search, the preview that played, and the file you downloaded
  // are three ids for one song. Matching on keys is what makes every surface
  // agree about what you own without any of them knowing where the song lives.
  const savedKeys = createMemo(() => new Set(state.saved.flatMap((f) => f.keys)));
  // The mark is a strict subset — a property of a saved song, never a way of
  // holding one.
  const favouriteKeys = createMemo(
    () => new Set(state.saved.filter((f) => f.favourite).flatMap((f) => f.keys)),
  );
  // Each saved song as something playable: the owned track when we have it,
  // a streaming preview when we don't. Resolved here rather than at save time,
  // so a download promotes the entry with no write and no reordering. The entry
  // is kept alongside its track, because only the entry knows whether a source
  // has been attached to it yet — and whether it is marked.
  const savedRows = createMemo(() =>
    state.saved
      .map((entry) => ({ entry, track: savedToTrack(entry, libraryIndex()) }))
      .filter((row): row is SavedRow => !!row.track),
  );
  const favouriteRows = createMemo(() => savedRows().filter((row) => row.entry.favourite));
  /**
   * The library as the user thinks of it: everything they have claimed.
   *
   * The songs with no file come first, then the files in the engine's own
   * order. A saved song that has since been downloaded resolves to its library
   * track and is dropped here rather than listed twice.
   *
   * The order matters because `sortTracks` reverses this whole list for
   * "recent", and reversing a concatenation swaps the blocks:
   * `reverse(a ++ b)` is `reverse(b) ++ reverse(a)`. Files last here means
   * files first there, which is what "recent" has to mean the moment a
   * download finishes — putting the streaming block first put every song the
   * user had ever saved and not downloaded above every file, forever. With 72
   * such saves a track downloaded a minute ago opened at position 73, below
   * songs from weeks earlier, and read as missing.
   *
   * This still is not a true recency order: a song saved just now sorts below
   * every file. Merging the two properly needs a `date_added` on tracks —
   * 150 of 197 files in the library this was found in carry no timestamp of
   * any kind. That column is the first item of the library-schema work in
   * docs/ROADMAP.md, and this ordering is what should be replaced once it
   * exists.
   */
  const libraryTracks = createMemo(() => {
    const files = state.library.filter(isMusicTrack);
    const streaming = savedRows()
      .filter((row) => row.track.source === 'preview' && isMusicTrack(row.track))
      .map((row) => row.track)
      .reverse();
    return streaming.length === 0 ? files : [...streaming, ...files];
  });
  // The marked subset that lives on disk, by library id — what the surfaces
  // that only speak library ids (sort, radio seeds, Auto Mode) already expect.
  const favouriteLibraryIds = createMemo(() => {
    const owned = new Set<string>();
    const index = libraryIndex();
    for (const entry of state.saved) {
      if (!entry.favourite) continue;
      for (const key of entry.keys) {
        const track = index.get(key);
        if (track) {
          owned.add(track.id);
          break;
        }
      }
    }
    return owned as ReadonlySet<string>;
  });
  return {
    libraryIndex,
    playingKeys,
    queuedKeys,
    savedKeys,
    savedRows,
    favouriteKeys,
    favouriteRows,
    libraryTracks,
    favouriteLibraryIds,
  };
});

/** Keys the playing track answers to. Reactive: read in a tracking scope. */
export const playingKeys = identity.playingKeys;

/** Does anything with these identity keys own the transport right now? */
export const isPlayingKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.playingKeys(), catalogLinks());

/** The row currently playing — whatever id the surface happens to hold. */
export const isPlayingTrack = (track: Track): boolean => isPlayingKeys(trackKeys(track));
export const isPlayingItem = (item: CatalogItem): boolean => isPlayingKeys(catalogItemKeys(item));
export const isPlayingResult = (result: SearchResult): boolean =>
  isPlayingKeys(searchResultKeys(result));
export const isPlayingEpisode = (episodeKey: string): boolean =>
  isPlayingKeys(podcastEpisodeKeys(episodeKey));

/** Is anything with these identity keys sitting in the playback queue? */
export const isQueuedKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.queuedKeys(), catalogLinks());

export const isQueuedTrack = (track: Track): boolean => isQueuedKeys(trackKeys(track));
export const isQueuedItem = (item: CatalogItem): boolean => isQueuedKeys(catalogItemKeys(item));
export const isQueuedResult = (result: SearchResult): boolean =>
  isQueuedKeys(searchResultKeys(result));

/** The library track this identity is owned as, if it is owned at all. */
export function ownedTrackForKeys(keys: string[]): Track | null {
  const index = identity.libraryIndex();
  for (const key of withLinkedKeys(keys, catalogLinks())) {
    const owned = index.get(key);
    if (owned) return owned;
  }
  return null;
}

export const ownedTrackForItem = (item: CatalogItem): Track | null =>
  ownedTrackForKeys(catalogItemKeys(item));
export const ownedTrackForResult = (result: SearchResult): Track | null =>
  ownedTrackForKeys(searchResultKeys(result));

/**
 * Is anything with these identities in the library?
 *
 * True for a downloaded song *and* for one saved without a file: owning the
 * bytes is one way to have a song, not the definition of having it. This is
 * what every surface asks before offering the heart — a song you have not
 * claimed cannot be marked out among the ones you have.
 */
export const isSavedKeys = (keys: string[]): boolean =>
  !!ownedTrackForKeys(keys) || keysMatch(keys, identity.savedKeys(), catalogLinks());

export const isSavedTrack = (track: Track): boolean => isSavedKeys(trackKeys(track));
export const isSavedItem = (item: CatalogItem): boolean => isSavedKeys(catalogItemKeys(item));
export const isSavedResult = (result: SearchResult): boolean =>
  isSavedKeys(searchResultKeys(result));

/** Is anything with these identities marked out among the songs you have? */
export const isFavouriteKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.favouriteKeys(), catalogLinks());

export const isFavouriteTrack = (track: Track): boolean => isFavouriteKeys(trackKeys(track));
export const isFavouriteItem = (item: CatalogItem): boolean =>
  isFavouriteKeys(catalogItemKeys(item));
export const isFavouriteResult = (result: SearchResult): boolean =>
  isFavouriteKeys(searchResultKeys(result));

/** Every saved song paired with the playable track it resolves to, newest
 * first. Owned tracks play their file; the rest stream. */
export const savedRows = identity.savedRows;

/** The marked subset of the same, in the same order. */
export const favouriteRows = identity.favouriteRows;

/** Every marked song as a playable track, newest first. */
export const favouriteTracks = (): Track[] => identity.favouriteRows().map((row) => row.track);

/** The saved entry behind these identities, if the library holds one. Used by
 * the surfaces that need to know *how* a song is held, not just whether. */
export function savedEntryForKeys(keys: string[]): SavedEntry | null {
  const all = withLinkedKeys(keys, catalogLinks());
  for (const entry of state.saved) {
    if (entry.keys.some((key) => all.includes(key))) return entry;
  }
  return null;
}

/** Is a download for this song in flight? Keyed off the video id, which is what
 * the downloader queue speaks — a failed or interrupted item is not in flight,
 * so its row offers the arrow again rather than spinning forever. */
export function isDownloadingKeys(keys: string[]): boolean {
  const videoIds = new Set(
    withLinkedKeys(keys, catalogLinks())
      .filter((key) => key.startsWith('yt:'))
      .map((key) => key.slice(3)),
  );
  if (!videoIds.size) return false;
  return state.downloads.queue.some(
    (item) =>
      !!item.video_id &&
      videoIds.has(item.video_id) &&
      item.status !== 'failed' &&
      item.status !== 'interrupted',
  );
}

export const isDownloadingTrack = (track: Track): boolean => isDownloadingKeys(trackKeys(track));

/** Library ids of the marked songs we hold a file for. */
export const favouriteLibraryIds = identity.favouriteLibraryIds;
