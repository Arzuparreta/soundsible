import { api } from './api';
import { libraryTrackFor, resultToTrack } from './queueDiscovery';
import type { Track } from '../types/music';

/** Resolve the YouTube identity needed by radio/related discovery. */
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
      // Fall through to literal YouTube search when catalog resolution is down.
    }
  }
  const query = `${track.title} ${track.artist}`.trim();
  if (!query) return null;
  const results = await api.searchYouTube(query, signal);
  return results[0]?.id ?? null;
}

/** Fetch playable related tracks while preferring an already-downloaded twin. */
export async function relatedTracksFor(
  track: Track,
  library: Track[],
  signal?: AbortSignal,
): Promise<{ youtubeId: string; tracks: Track[] }> {
  const youtubeId = await resolveTrackYoutubeId(track, signal);
  if (!youtubeId) return { youtubeId: '', tracks: [] };
  const results = await api.relatedYouTube(youtubeId, signal, false);
  return {
    youtubeId,
    tracks: results
      .filter((result) => result.id !== youtubeId && result.id !== track.id)
      .map((result) => libraryTrackFor(library, result) ?? resultToTrack(result)),
  };
}
