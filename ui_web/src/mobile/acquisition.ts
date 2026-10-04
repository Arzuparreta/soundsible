import { request } from '../lib/http';
import { trackKeys } from '../lib/playbackIdentity';
import { isPodcastTrack } from '../lib/track';
import type { Track } from '../types/music';
import type { DownloadQueueItem } from '../types/download';

/** Explicit acquisition belongs to the engine queue; it never changes native playback. */
export function createMusicAcquisition(identity: () => number, ready: () => boolean, signal: () => AbortSignal,
  library: () => Track[], jobs: () => DownloadQueueItem[], refresh: () => Promise<void>) {
  const pending = new Map<string, Promise<void>>();
  const acquired = (id: string) => library().some(row => row.source !== 'preview' && !isPodcastTrack(row) && (row.id === id || row.youtube_id === id));
  const active = (id: string) => jobs().some(row => row.video_id === id && row.status !== 'failed' && row.status !== 'interrupted');
  function add(track: Track): Promise<void> {
    if (!ready() || track.source !== 'preview' || isPodcastTrack(track) || !/^[A-Za-z0-9_-]{11}$/.test(track.id)) return Promise.reject(new Error('Unsupported acquisition'));
    if (acquired(track.id) || active(track.id)) return Promise.resolve();
    const owner = identity(), key = `${owner}:${track.id}`;
    const existing = pending.get(key); if (existing) return existing;
    const current = () => identity() === owner && ready();
    const operation = (async () => {
      const reply = await request<{ status: string; accepted: { index: number; id: string }[]; rejected: unknown[] }>('/api/downloader/queue', {
        method: 'POST', signal: signal(), timeoutMs: 15000, body: { items: [{ source_type: 'youtube_url', song_str: `https://www.youtube.com/watch?v=${track.id}`,
          video_id: track.id, display_title: track.title, display_artist: track.artist, thumbnail_url: track.cover, duration_sec: track.duration,
          metadata_evidence: null, identity_keys: trackKeys(track) }] },
      });
      if (!current()) return;
      if (reply.status !== 'queued' || !Array.isArray(reply.accepted) || reply.accepted.length !== 1 || reply.accepted[0].index !== 0 || !reply.accepted[0].id || !Array.isArray(reply.rejected) || reply.rejected.length) throw new Error('Missing acquisition confirmation');
      await refresh();
    })().finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    pending.set(key, operation); return operation;
  }
  return { add, busy: (id: string) => pending.has(`${identity()}:${id}`) || active(id), acquired };
}
