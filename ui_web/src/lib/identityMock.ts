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
import type { CatalogItem, SearchResult, Track } from '../types/music';

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
}) {
  const links = () => read.links?.() ?? new Map<string, string>();
  const playing = () => resolvePlayingKeys(read.currentTrack(), buildIdentityIndex(read.library()), links());
  const queued = () => collectIdentityKeys(read.queue?.() ?? []);
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
  };
}
