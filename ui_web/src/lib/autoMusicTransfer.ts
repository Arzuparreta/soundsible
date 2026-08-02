import type { Track } from '../types/music';

export const AUTO_TRACK_MIME = 'application/x-soundsible-auto-track';

export interface AutoTrackTransfer {
  track: Track;
  queueId?: string;
}

export function writeAutoTrackTransfer(event: DragEvent, value: AutoTrackTransfer): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(AUTO_TRACK_MIME, JSON.stringify(value));
  event.dataTransfer.setData('text/plain', `${value.track.title} — ${value.track.artist}`);
}

export function readAutoTrackTransfer(event: DragEvent): AutoTrackTransfer | null {
  const raw = event.dataTransfer?.getData(AUTO_TRACK_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AutoTrackTransfer;
    return parsed?.track?.id ? parsed : null;
  } catch {
    return null;
  }
}
