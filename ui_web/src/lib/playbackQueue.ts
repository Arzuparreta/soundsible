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
  /** Artwork for the card that stands in for this context in the queue. */
  cover?: string;
  /** The page this context was played from. Absent for a collection with no
   * page of its own — a set of search results — which the card names without
   * offering somewhere to go. */
  destination?: string;
}

/**
 * A catalog song a context holds before it has been matched to a video.
 *
 * Matching costs the engine a search, so a record played from Deezer cannot
 * match every song up front — and dropping the ones that were not matched yet
 * is how an album used to lose half its tracks. The context keeps the song in
 * its place instead, and the store matches it shortly before it is needed.
 */
export interface PendingCatalogReference {
  catalogItemId: string;
  artist: string;
  title: string;
  duration?: number;
}

/** A song a context can be built from: playable, or waiting to be matched. */
export type ContextTrack = Track & { pendingResolve?: PendingCatalogReference };

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
    directionRevision?: number;
    placement?: 'dj' | 'fixed';
    /** queueId of the user occurrence this bridge exists for. */
    ownerQueueId?: string;
  };
  /** Set until this occurrence has been matched to something playable. Its
   * `id` is a placeholder meanwhile, never a stream. */
  pendingResolve?: PendingCatalogReference;
}

export function isPendingEntry(track: ContextTrack | null | undefined): boolean {
  return Boolean(track?.pendingResolve);
}

let occurrenceSequence = 0;

export function createQueueEntry(
  track: ContextTrack,
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

/**
 * What the queue shows once the listener's own requests run out.
 *
 * The context lane is a continuation, not a list of decisions, so the queue
 * draws it as one card. `remaining` counts what is still ahead of the current
 * entry; with repeat-all the context also goes round again, so it continues
 * for as long as anything of it is left to come back to.
 */
export interface ContextContinuation {
  context: PlaybackContextDescriptor;
  remaining: number;
  /** The next occurrence the context will play, for artwork and navigation. */
  next: PlaybackQueueEntry;
}

export function contextContinuation(
  queue: readonly PlaybackQueueEntry[],
  index: number,
  repeatAll: boolean,
): ContextContinuation | null {
  const ahead = futureEntries(queue, index, 'context');
  const next = ahead[0]
    ?? (repeatAll ? queue.find((entry, position) => position !== index && entry.queueLane === 'context') : undefined);
  if (!next?.queueContext) return null;
  return { context: next.queueContext, remaining: ahead.length, next };
}
