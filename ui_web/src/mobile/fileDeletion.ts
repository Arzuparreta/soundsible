import { ApiError, request } from '../lib/http';
import { api } from '../lib/api';
import { isPodcastTrack } from '../lib/track';
import type { Track } from '../types/music';

/** Server retirement is confirmed before touching the single native program or its copy. */
export function createNativeFileDeletion(identity: () => number, ready: () => boolean,
  signal: () => AbortSignal, library: () => Track[], retire: (id: string) => Promise<void>,
  removeCopy: (id: string) => Promise<void>, refresh: () => Promise<void>) {
  const pending = new Map<string, Promise<boolean>>();
  function remove(track: Track, keepSaved = false): Promise<boolean> {
    const downloaded = track.source !== 'preview';
    if (!ready() || isPodcastTrack(track) || (!downloaded && !track.item_id)
        || (keepSaved && !track.can_remove_download)
        || (downloaded && !library().some(row => row.id === track.id && row.source !== 'preview'))) {
      return Promise.reject(new Error('Acquired music required'));
    }
    const owner = identity(), key = `${owner}:${track.id}`;
    const existing = pending.get(key); if (existing) return existing;
    const current = () => identity() === owner && ready();
    let confirmed = false;
    const operation = (async () => {
      try {
        let retired = downloaded ? [track.id] : [];
        try {
          const receipt = track.item_id
            ? await api.removeCollectionTrack(track.item_id, keepSaved, signal())
            : await request<{ status: string; retired_file_ids?: string[] }>(`/api/library/tracks/${encodeURIComponent(track.id)}`, {
            method: 'DELETE', signal: signal(), timeoutMs: 15000,
          });
          if (!current()) return false;
          if (receipt.status !== 'success') throw new Error('Missing deletion receipt');
          retired = [...new Set([...retired, ...(receipt.retired_file_ids ?? [])])];
        } catch (error) {
          // A previous confirmed delete may have failed during local cleanup. A fresh
          // private snapshot must still prove absence before retrying that cleanup.
          if (!current()) return false;
          if (track.item_id || !(error instanceof ApiError && error.status === 404)) throw error;
        }
        if (retired.length) {
          const snapshot = await request<{ tracks: Track[] }>('/api/library', { signal: signal(), cache: 'no-store', timeoutMs: 30000 });
          if (!current()) return false;
          if (!Array.isArray(snapshot.tracks) || snapshot.tracks.some(row => retired.includes(row.id) && row.source !== 'preview')) {
            throw new Error('File retirement not confirmed');
          }
        }
        confirmed = true;
        for (const id of retired) {
          await retire(id);
          if (!current()) return false;
          await removeCopy(id);
          if (!current()) return false;
        }
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
