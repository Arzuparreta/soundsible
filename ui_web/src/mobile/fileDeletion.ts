import { ApiError, request } from '../lib/http';
import { isPodcastTrack } from '../lib/track';
import type { Track } from '../types/music';

/** Server retirement is confirmed before touching the single native program or its copy. */
export function createNativeFileDeletion(identity: () => number, ready: () => boolean,
  signal: () => AbortSignal, library: () => Track[], retire: (id: string) => Promise<void>,
  removeCopy: (id: string) => Promise<void>, refresh: () => Promise<void>) {
  const pending = new Map<string, Promise<boolean>>();
  function remove(track: Track): Promise<boolean> {
    if (!ready() || track.source === 'preview' || isPodcastTrack(track) || !library().some(row => row.id === track.id && row.source !== 'preview')) {
      return Promise.reject(new Error('Acquired music required'));
    }
    const owner = identity(), key = `${owner}:${track.id}`;
    const existing = pending.get(key); if (existing) return existing;
    const current = () => identity() === owner && ready();
    let confirmed = false;
    const operation = (async () => {
      try {
        try {
          const receipt = await request<{ status: string }>(`/api/library/tracks/${encodeURIComponent(track.id)}`, {
            method: 'DELETE', signal: signal(), timeoutMs: 15000,
          });
          if (!current()) return false;
          if (receipt.status !== 'success') throw new Error('Missing deletion receipt');
        } catch (error) {
          // A previous confirmed delete may have failed during local cleanup. A fresh
          // private snapshot must still prove absence before retrying that cleanup.
          if (!current()) return false;
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        const snapshot = await request<{ tracks: Track[] }>('/api/library', { signal: signal(), cache: 'no-store', timeoutMs: 30000 });
        if (!current()) return false;
        if (!Array.isArray(snapshot.tracks) || snapshot.tracks.some(row => row.id === track.id && row.source !== 'preview')) throw new Error('File retirement not confirmed');
        confirmed = true;
        await retire(track.id);
        if (!current()) return false;
        await removeCopy(track.id);
      } finally {
        // Even a local cleanup failure must refresh a server deletion already committed.
        if (confirmed && current()) await refresh();
      }
      return current();
    })().finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    pending.set(key, operation); return operation;
  }
  return { remove, busy: (id: string) => pending.has(`${identity()}:${id}`) };
}
