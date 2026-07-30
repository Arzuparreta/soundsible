import { api } from './api';
import type { Track } from '../types/music';

/** Resolve the playable YouTube identity for a library or preview track. */
export async function resolveTrackYoutubeId(track: Track, signal?: AbortSignal): Promise<string | null> {
  if (track.youtube_id) return track.youtube_id;
  if (track.source === 'preview') return track.id;
  if (track.artist && track.title) {
    try {
      const resolved = await api.resolveCatalogItem(
        { artist: track.artist, title: track.title, duration: track.duration },
        signal,
      );
      if (resolved.video_id) return resolved.video_id;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const query = `${track.title} ${track.artist}`.trim();
  if (!query) return null;
  const results = await api.searchYouTube(query, signal);
  return results[0]?.id ?? null;
}
