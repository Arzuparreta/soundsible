import type { DeviceCommandAnswer } from './api';
import { t } from './i18n';
import type { ContextTrack } from './playbackQueue';
import { isPodcastTrack } from './track';

/** A command carries identity and metadata, never a device's resolved media URL. */
export function canPlayOnDevice(track: ContextTrack): boolean {
  if (!track.id) return false;
  if (isPodcastTrack(track)) return track.source !== 'preview' || Boolean(track.podcast_enclosure_url);
  return track.source !== 'preview' || /^[A-Za-z0-9_-]{11}$/.test(track.youtube_id || track.id) || Boolean(track.title && track.artist);
}

export function prepareRemoteTrack(track: ContextTrack): ContextTrack {
  if (track.pendingResolve) return { ...track, source: 'preview' };
  if (track.source === 'preview' && !isPodcastTrack(track) &&
    !/^[A-Za-z0-9_-]{11}$/.test(track.youtube_id || track.id)) {
    return { ...track, pendingResolve: { catalogItemId: track.id, artist: track.artist, title: track.title, duration: track.duration } };
  }
  return track;
}

export function remotePlayTracksArgs(track: ContextTrack): { tracks: [ContextTrack]; index: 0 } {
  return { tracks: [prepareRemoteTrack(track)], index: 0 };
}

const REASON_KEYS: Record<string, string> = {
  offline: 'deviceSheet.offline',
  timeout: 'deviceSheet.timeout',
  update_required: 'deviceSheet.updateRequired',
  unsupported: 'deviceSheet.unsupported',
  locked: 'deviceSheet.locked',
  not_found: 'deviceSheet.notFound',
  needs_gesture: 'deviceSheet.needsGesture',
  nothing_playing: 'deviceSheet.nothingPlaying',
};

export function remoteCommandMessage(answer: DeviceCommandAnswer | null | undefined, deviceName: string): string {
  const key = answer && answer.status !== 'applied' ? REASON_KEYS[answer.reason] : undefined;
  return t(key ?? 'deviceSheet.failed', { device: deviceName });
}
