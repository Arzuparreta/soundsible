import { request } from '../lib/http';
import type { CollectionSnapshot } from '../lib/api';
import { buildIdentityIndex } from '../lib/playbackIdentity';
import { musicLibraryRows } from '../lib/musicLibrary';
import { savedToTrack } from '../lib/saved';
import { isPodcastTrack } from '../lib/track';
import type { SavedEntry, Track } from '../types/music';
import type { BrowseSnapshot } from './LibraryBrowser';

interface AccountCollection { snapshot: BrowseSnapshot; saved: SavedEntry[]; files: Track[] }

/** One reader per account lifetime; canonical engines refresh one resource. */
export function createNativeCollectionReader() {
  let canonical = false;
  let etag: string | undefined;
  let previous: AccountCollection | undefined;
  return async (signal: AbortSignal): Promise<AccountCollection> => {
    const options = { signal, cache: 'no-store' as const, timeoutMs: 30000 };
    if (!canonical) {
      const library = await request<BrowseSnapshot>('/api/library', { ...options,
        onResponse: response => { canonical = response.headers.get('X-Soundsible-Collection') === 'true'; } });
      if (!canonical) {
        const saved = await request<{ saved: SavedEntry[] }>('/api/library/saved', options);
        if (!Array.isArray(library.tracks) || !Array.isArray(saved.saved)) throw new Error('Invalid library');
        const index = buildIdentityIndex(library.tracks);
        const streams = saved.saved.map(entry => savedToTrack(entry, index)).filter((track): track is Track => !!track);
        return { snapshot: { ...library, tracks: musicLibraryRows(library.tracks, streams),
          podcast_tracks: library.tracks.filter(isPodcastTrack) }, saved: saved.saved, files: library.tracks };
      }
    }
    let nextETag: string | undefined;
    const collection = await request<CollectionSnapshot | null>('/api/library/collection', { ...options,
      ifNoneMatch: etag, onETag: value => { nextETag = value ?? undefined; } });
    if (!collection) {
      if (!previous) throw new Error('Missing initial collection');
      return previous;
    }
    if (!Array.isArray(collection.items) || !Array.isArray(collection.files) || !Array.isArray(collection.saved)) throw new Error('Invalid collection');
    previous = { snapshot: { tracks: collection.items, podcast_tracks: collection.files.filter(isPodcastTrack),
      playlists: collection.playlists, settings: collection.settings, podcast_subscriptions: collection.podcast_subscriptions },
      saved: collection.saved, files: collection.files };
    etag = nextETag;
    return previous;
  };
}
