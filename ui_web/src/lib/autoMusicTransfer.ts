import { createSignal } from 'solid-js';
import type { Track } from '../types/music';

export const AUTO_TRACK_MIME = 'application/x-soundsible-auto-track';

export interface AutoTrackTransfer {
  track: Track;
  queueId?: string;
}

const [dragging, setDragging] = createSignal(false);

/**
 * True while a song is being dragged anywhere in Auto Mode.
 *
 * Drop targets read it to light up the moment a drag begins. The Sources tray
 * only ever showed itself once you were already carrying something by
 * long-press, so with a mouse the gesture had nothing at all to announce it:
 * you had to guess the tray would take a song before you would ever drag one
 * there.
 */
export const autoTrackDragging = dragging;

export function writeAutoTrackTransfer(event: DragEvent, value: AutoTrackTransfer): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(AUTO_TRACK_MIME, JSON.stringify(value));
  event.dataTransfer.setData('text/plain', `${value.track.title} — ${value.track.artist}`);
  setDragging(true);
  // `dragend` fires on the source whether the drop was taken or abandoned, and
  // it bubbles, so one self-removing listener closes out every drag.
  const clear = () => {
    setDragging(false);
    window.removeEventListener('dragend', clear);
  };
  window.addEventListener('dragend', clear);
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
