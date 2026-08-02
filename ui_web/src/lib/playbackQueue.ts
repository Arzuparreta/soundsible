import type { Track } from '../types/music';

export type QueueLane = 'manual' | 'context' | 'generated';
export type QueueSource =
  | 'play_next'
  | 'add_to_queue'
  | 'library'
  | 'favourites'
  | 'playlist'
  | 'album'
  | 'artist'
  | 'search'
  | 'single'
  | 'podcast'
  | 'autoplay'
  | 'radio'
  | 'auto_mode';

export type PlaybackContextKind =
  | 'library'
  | 'favourites'
  | 'playlist'
  | 'album'
  | 'artist'
  | 'search'
  | 'single'
  | 'podcast';

export interface PlaybackContextDescriptor {
  id: string;
  kind: PlaybackContextKind;
  label: string;
}

/**
 * One occurrence in the active play order.
 *
 * It deliberately extends Track so existing playback/rendering code can keep
 * reading `id`, `title`, `source`, etc. `queueId` identifies the occurrence:
 * the same song may legitimately be requested more than once.
 */
export interface PlaybackQueueEntry extends Track {
  queueId: string;
  queueLane: QueueLane;
  queueSource: QueueSource;
  queueContext?: PlaybackContextDescriptor;
  queueContextIndex?: number;
  /** Auto Mode owns placement, not musical identity. A song may independently
   * be present in the source tray and as one or more route occurrences. */
  autoRoute?: {
    kind: 'generated' | 'user' | 'bridge';
    placement?: 'dj' | 'fixed';
    /** queueId of the user occurrence this bridge exists for. */
    ownerQueueId?: string;
  };
}

let occurrenceSequence = 0;

export function createQueueEntry(
  track: Track,
  lane: QueueLane,
  source: QueueSource,
  context?: PlaybackContextDescriptor,
  contextIndex?: number,
): PlaybackQueueEntry {
  occurrenceSequence += 1;
  return {
    ...track,
    queueId: `q-${Date.now().toString(36)}-${occurrenceSequence.toString(36)}`,
    queueLane: lane,
    queueSource: source,
    queueContext: context,
    queueContextIndex: contextIndex,
  };
}

export function defaultContext(tracks: readonly Track[]): PlaybackContextDescriptor {
  return tracks.length === 1
    ? { id: 'single', kind: 'single', label: '' }
    : { id: 'selection', kind: 'search', label: '' };
}

export function futureEntries(
  queue: readonly PlaybackQueueEntry[],
  index: number,
  lane?: QueueLane,
): PlaybackQueueEntry[] {
  const upcoming = queue.slice(Math.max(0, index + 1));
  return lane ? upcoming.filter((entry) => entry.queueLane === lane) : upcoming;
}

export function manualInsertIndex(
  queue: readonly PlaybackQueueEntry[],
  currentIndex: number,
  position: 'next' | 'last',
): number {
  if (position === 'next') return Math.max(0, currentIndex + 1);
  let at = Math.max(0, currentIndex + 1);
  while (at < queue.length && queue[at].queueLane === 'manual') at += 1;
  return at;
}

export function contextSource(kind: PlaybackContextKind): QueueSource {
  return kind;
}

export function sameQueueSection(a: PlaybackQueueEntry, b: PlaybackQueueEntry): boolean {
  if (a.queueLane !== b.queueLane) return false;
  if (a.queueLane !== 'generated') return true;
  return a.queueSource === b.queueSource;
}
