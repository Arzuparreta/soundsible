import type { DjDirection, DjProfile } from './api';
import type { AutoModeState, AutoMusicSet, AutoPlanItem, AutoProfile } from './generatedQueue';
import type { PlaybackQueueEntry } from './playbackQueue';
import type { Track } from '../types/music';

/**
 * The listening session as another device has to rebuild it.
 *
 * Cross-device resume used to carry one song and a position. Picking it up
 * therefore rebuilt a one-track Now Playing queue whatever had actually been
 * driving: an Auto Mode session arrived as an ordinary one — same song, no
 * route, no sources, no direction, nothing left to continue from.
 *
 * What travels instead is the session itself: the queue and the place in it,
 * the transport preferences that belong to the session rather than to the
 * device, and — when Auto was driving — everything the DJ workspace is made of.
 *
 * Bounded on purpose. The snapshot is published to the engine and persisted per
 * user, so it keeps a window around the current entry rather than an unbounded
 * history, and the source trays travel as the direction they are rather than as
 * a whole library.
 */
export const PLAYBACK_SESSION_VERSION = 1;

/**
 * How much of a session travels.
 *
 * Sized to stay well inside the 64 KB a `keepalive` request may weigh, because
 * the moment the snapshot matters most is the one where the page is leaving:
 * following the secure station's address, or simply being closed. A session
 * that could not be published as the page went is a session nobody can pick up.
 */
/** Entries kept behind the current one: enough to know where the session came
 * from, not a listening history. */
const MAX_HISTORY = 5;
/** Entries kept ahead of it — deeper than the runway the planner keeps warm. */
const MAX_UPCOMING = 40;
const MAX_SOURCES = 6;
const MAX_SOURCE_TRACKS = 15;
const MAX_HEARD = 15;
const MAX_AVOIDED = 60;

export type SessionMode = 'now_playing' | 'auto';
export type SessionRepeat = 'off' | 'all' | 'one';

/** The DJ workspace, minus everything that is in flight rather than decided:
 * a transition being mixed, an activity line, a debounce waiting to fire. */
export interface PlaybackSessionAuto {
  profile: AutoProfile;
  djProfile: DjProfile;
  direction: DjDirection;
  sources: AutoMusicSet[];
  heard: Track[];
  avoidedIdentities: string[];
  plan: Record<string, AutoPlanItem>;
  staleSeams: string[];
}

export interface PlaybackSessionSnapshot {
  v: typeof PLAYBACK_SESSION_VERSION;
  /** Which surface was driving. `auto` is what makes a resume rebuild the DJ
   * workspace instead of handing the song back as Now Playing. */
  mode: SessionMode;
  queue: PlaybackQueueEntry[];
  /** Index of the current entry *within `queue`* — the window is re-based, so
   * this is never the index the publishing device held. */
  index: number;
  shuffle: boolean;
  repeat: SessionRepeat;
  radio: { active: boolean; seedId: string | null };
  auto: PlaybackSessionAuto | null;
}

export interface PlaybackSessionInput {
  queue: readonly PlaybackQueueEntry[];
  index: number;
  shuffle: boolean;
  repeat: SessionRepeat;
  radioMode: boolean;
  radioSeedId: string | null;
  auto: AutoModeState;
}

function isTrackLike(value: unknown): value is Track {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Track).id === 'string'
    && (value as Track).id.length > 0;
}

function isEntryLike(value: unknown): value is PlaybackQueueEntry {
  return isTrackLike(value) && typeof (value as PlaybackQueueEntry).queueId === 'string';
}

function trackList(value: unknown, max: number): Track[] {
  return Array.isArray(value) ? value.filter(isTrackLike).slice(0, max) : [];
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, max)
    : [];
}

function sources(value: readonly AutoMusicSet[]): AutoMusicSet[] {
  // Newest activation first: a tray that outgrew the cap keeps the direction
  // the listener steered towards most recently, not the one they started with.
  return [...value]
    .sort((a, b) => (b.activation ?? 0) - (a.activation ?? 0))
    .slice(0, MAX_SOURCES)
    .map((source) => ({ ...source, tracks: source.tracks.slice(0, MAX_SOURCE_TRACKS) }));
}

function readSources(value: unknown): AutoMusicSet[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is AutoMusicSet => (
      Boolean(item) && typeof item === 'object' && typeof (item as AutoMusicSet).id === 'string'
    ))
    .slice(0, MAX_SOURCES)
    .map((source, order) => ({
      id: source.id,
      label: typeof source.label === 'string' ? source.label : '',
      tracks: trackList(source.tracks, MAX_SOURCE_TRACKS),
      activation: typeof source.activation === 'number' ? source.activation : order + 1,
    }))
    .filter((source) => source.tracks.length > 0);
}

/** Plan entries and stale seams only mean anything against occurrences that
 * travelled, so both are cut down to the window rather than shipped whole. */
function planFor(plan: Record<string, AutoPlanItem>, queueIds: Set<string>): Record<string, AutoPlanItem> {
  return Object.fromEntries(Object.entries(plan).filter(([queueId]) => queueIds.has(queueId)));
}

function readPlan(value: unknown, queueIds: Set<string>): Record<string, AutoPlanItem> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (pair): pair is [string, AutoPlanItem] => (
        queueIds.has(pair[0])
        && Boolean(pair[1])
        && typeof pair[1] === 'object'
        && typeof (pair[1] as AutoPlanItem).trackId === 'string'
      ),
    ),
  );
}

/**
 * Take a session snapshot, or `null` when there is no session to describe.
 *
 * The window is anchored on the current entry: the runway ahead is what a
 * resume continues into, and the handful of entries behind it are what makes
 * "previous" mean something on the device that picks it up.
 */
export function buildPlaybackSession(input: PlaybackSessionInput): PlaybackSessionSnapshot | null {
  const entries = input.queue.filter(isEntryLike);
  if (entries.length === 0) return null;
  const index = input.index >= 0 && input.index < entries.length ? input.index : -1;
  const start = index < 0 ? 0 : Math.max(0, index - MAX_HISTORY);
  const queue = entries.slice(start, (index < 0 ? 0 : index) + MAX_UPCOMING + 1);
  if (queue.length === 0) return null;
  const queueIds = new Set(queue.map((entry) => entry.queueId));
  const auto = input.auto;
  return {
    v: PLAYBACK_SESSION_VERSION,
    mode: auto.active ? 'auto' : 'now_playing',
    queue,
    index: index < 0 ? -1 : index - start,
    shuffle: input.shuffle,
    repeat: input.repeat,
    radio: { active: input.radioMode, seedId: input.radioSeedId },
    auto: auto.active
      ? {
          profile: auto.profile,
          djProfile: auto.djProfile,
          direction: auto.direction,
          sources: sources(auto.sources),
          heard: auto.heard.slice(-MAX_HEARD),
          avoidedIdentities: auto.avoidedIdentities.slice(-MAX_AVOIDED),
          plan: planFor(auto.plan, queueIds),
          staleSeams: auto.staleSeams.filter((queueId) => queueIds.has(queueId)),
        }
      : null,
  };
}

/**
 * Read a snapshot published by another device — or by an older build of this
 * one. Anything unrecognised is not a session: resume falls back to the single
 * track it always carried rather than restoring half a workspace.
 */
export function readPlaybackSession(value: unknown): PlaybackSessionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PlaybackSessionSnapshot>;
  if (raw.v !== PLAYBACK_SESSION_VERSION) return null;
  const queue = Array.isArray(raw.queue)
    ? raw.queue.filter(isEntryLike).slice(0, MAX_HISTORY + MAX_UPCOMING + 1)
    : [];
  if (queue.length === 0) return null;
  const index = typeof raw.index === 'number' && raw.index >= 0 && raw.index < queue.length
    ? Math.floor(raw.index)
    : 0;
  const queueIds = new Set(queue.map((entry) => entry.queueId));
  const rawAuto = raw.auto && typeof raw.auto === 'object' ? raw.auto as Partial<PlaybackSessionAuto> : null;
  const mode: SessionMode = raw.mode === 'auto' && rawAuto ? 'auto' : 'now_playing';
  const direction = rawAuto?.direction && typeof rawAuto.direction === 'object' ? rawAuto.direction : null;
  return {
    v: PLAYBACK_SESSION_VERSION,
    mode,
    queue,
    index,
    shuffle: raw.shuffle === true,
    repeat: raw.repeat === 'all' || raw.repeat === 'one' ? raw.repeat : 'off',
    radio: {
      active: raw.radio?.active === true,
      seedId: typeof raw.radio?.seedId === 'string' ? raw.radio.seedId : null,
    },
    auto: mode === 'auto' && rawAuto
      ? {
          profile: rawAuto.profile === 'familiar' || rawAuto.profile === 'explore'
            ? rawAuto.profile
            : 'balanced',
          djProfile: rawAuto.djProfile === 'long_blend'
            || rawAuto.djProfile === 'cuts_drops'
            || rawAuto.djProfile === 'open_format'
            ? rawAuto.djProfile
            : 'adaptive',
          direction: {
            energy: typeof direction?.energy === 'number' ? direction.energy : 0,
            familiarity: typeof direction?.familiarity === 'number' ? direction.familiarity : 0,
            prompt: typeof direction?.prompt === 'string' ? direction.prompt : '',
            include: stringList(direction?.include, MAX_AVOIDED),
            exclude: stringList(direction?.exclude, MAX_AVOIDED),
          },
          sources: readSources(rawAuto.sources),
          heard: trackList(rawAuto.heard, MAX_HEARD),
          avoidedIdentities: stringList(rawAuto.avoidedIdentities, MAX_AVOIDED),
          plan: readPlan(rawAuto.plan, queueIds),
          staleSeams: stringList(rawAuto.staleSeams, queue.length).filter((id) => queueIds.has(id)),
        }
      : null,
  };
}
