import {
  buildIdentityIndex,
  catalogItemKeys,
  collectIdentityKeys,
  keysMatch,
  podcastEpisodeKeys,
  resolvePlayingKeys,
  searchResultKeys,
  trackKeys,
} from './playbackIdentity';
import { savedToTrack } from './saved';
import type { CatalogItem, SavedEntry, SearchResult, Track } from '../types/music';

/**
 * Test-only: the store's identity predicates over a hand-built state snapshot.
 *
 * Route tests replace the whole store with a mock object, which would leave
 * every "is this row playing?" check to be re-invented per test file — the very
 * duplication this module exists to remove. Building the predicates from the
 * same pure functions the real store memoizes keeps the mocks honest: if the
 * identity rules change, the tests change with them.
 *
 * No memoization here; correctness is what tests need, not throughput.
 */
export function identityMock(read: {
  currentTrack: () => Track | null;
  library: () => Track[];
  queue?: () => Track[];
  links?: () => ReadonlyMap<string, string>;
  /** The whole collection: songs held without a file, each flagged or not. */
  saved?: () => SavedEntry[];
  /** Downloads in flight, by video id. */
  downloading?: () => string[];
}) {
  const links = () => read.links?.() ?? new Map<string, string>();
  const playing = () => resolvePlayingKeys(read.currentTrack(), buildIdentityIndex(read.library()), links());
  const queued = () => collectIdentityKeys(read.queue?.() ?? []);
  const saved = () => read.saved?.() ?? [];
  const savedKeys = () => new Set(saved().flatMap((f) => f.keys));
  const favourites = () => saved().filter((f) => f.favourite);
  const favouriteKeys = () => new Set(favourites().flatMap((f) => f.keys));
  const owned = (keys: string[]) => {
    const index = buildIdentityIndex(read.library());
    for (const key of keys) {
      const track = index.get(key);
      if (track) return track;
    }
    return null;
  };

  return {
    isPlayingKeys: (keys: string[]) => keysMatch(keys, playing(), links()),
    isPlayingTrack: (track: Track) => keysMatch(trackKeys(track), playing(), links()),
    isPlayingItem: (item: CatalogItem) => keysMatch(catalogItemKeys(item), playing(), links()),
    isPlayingResult: (result: SearchResult) => keysMatch(searchResultKeys(result), playing(), links()),
    isPlayingEpisode: (key: string) => keysMatch(podcastEpisodeKeys(key), playing(), links()),
    isQueuedKeys: (keys: string[]) => keysMatch(keys, queued(), links()),
    isQueuedTrack: (track: Track) => keysMatch(trackKeys(track), queued(), links()),
    isQueuedItem: (item: CatalogItem) => keysMatch(catalogItemKeys(item), queued(), links()),
    isQueuedResult: (result: SearchResult) => keysMatch(searchResultKeys(result), queued(), links()),
    ownedTrackForKeys: owned,
    ownedTrackForItem: (item: CatalogItem) => owned(catalogItemKeys(item)),
    ownedTrackForResult: (result: SearchResult) => owned(searchResultKeys(result)),
    isSavedKeys: (keys: string[]) => !!owned(keys) || keysMatch(keys, savedKeys(), links()),
    isSavedTrack: (track: Track) =>
      !!owned(trackKeys(track)) || keysMatch(trackKeys(track), savedKeys(), links()),
    isSavedItem: (item: CatalogItem) =>
      !!owned(catalogItemKeys(item)) || keysMatch(catalogItemKeys(item), savedKeys(), links()),
    isSavedResult: (result: SearchResult) =>
      !!owned(searchResultKeys(result)) || keysMatch(searchResultKeys(result), savedKeys(), links()),
    isDownloadingKeys: (keys: string[]) => {
      const inFlight = new Set(read.downloading?.() ?? []);
      if (!inFlight.size) return false;
      return keys.some((key) => key.startsWith('yt:') && inFlight.has(key.slice(3)));
    },
    isDownloadingTrack: (track: Track) => {
      const inFlight = new Set(read.downloading?.() ?? []);
      if (!inFlight.size) return false;
      return trackKeys(track).some((key) => key.startsWith('yt:') && inFlight.has(key.slice(3)));
    },
    savedEntryForKeys: (keys: string[]) =>
      saved().find((entry) => entry.keys.some((key) => keys.includes(key))) ?? null,
    isFavouriteKeys: (keys: string[]) => keysMatch(keys, favouriteKeys(), links()),
    isFavouriteTrack: (track: Track) => keysMatch(trackKeys(track), favouriteKeys(), links()),
    isFavouriteItem: (item: CatalogItem) => keysMatch(catalogItemKeys(item), favouriteKeys(), links()),
    isFavouriteResult: (result: SearchResult) =>
      keysMatch(searchResultKeys(result), favouriteKeys(), links()),
    favouriteTracks: () =>
      favourites()
        .map((entry) => savedToTrack(entry, buildIdentityIndex(read.library())))
        .filter((track): track is Track => !!track),
    favouriteLibraryIds: () => {
      const index = buildIdentityIndex(read.library());
      const ids = new Set<string>();
      for (const entry of favourites()) {
        for (const key of entry.keys) {
          const track = index.get(key);
          if (track) {
            ids.add(track.id);
            break;
          }
        }
      }
      return ids as ReadonlySet<string>;
    },
  };
}
