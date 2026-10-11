import type { ContextTrack } from './playbackQueue';
import { isPodcastTrack } from './track';

/** A command carries identity and metadata, never a device's resolved media URL. */
export function canPlayOnDevice(track: ContextTrack): boolean {
  if (!track.id) return false;
  if (isPodcastTrack(track)) return track.source !== 'preview' || Boolean(track.podcast_enclosure_url);
  return track.source !== 'preview' || /^[A-Za-z0-9_-]{11}$/.test(track.youtube_id || track.id) || Boolean(track.title && track.artist);
}

export function remotePlayRequest(track: ContextTrack): { track_id: string; track: ContextTrack } {
  if (track.pendingResolve) track = { ...track, source: 'preview' };
  if (track.source === 'preview' && !isPodcastTrack(track) && !track.pendingResolve &&
    !/^[A-Za-z0-9_-]{11}$/.test(track.youtube_id || track.id)) {
    track = { ...track, pendingResolve: { catalogItemId: track.id, artist: track.artist, title: track.title, duration: track.duration } };
  }
  return { track_id: track.id, track };
}
