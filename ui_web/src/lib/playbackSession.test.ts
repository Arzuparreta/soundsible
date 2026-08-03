import { describe, expect, it } from 'vitest';
import {
  buildPlaybackSession,
  readPlaybackSession,
  PLAYBACK_SESSION_VERSION,
  type PlaybackSessionInput,
} from './playbackSession';
import type { AutoModeState } from './generatedQueue';
import type { PlaybackQueueEntry } from './playbackQueue';
import type { Track } from '../types/music';

function track(id: string): Track {
  return { id, title: id.toUpperCase(), artist: 'Artist', duration: 180 };
}

function entry(id: string, over: Partial<PlaybackQueueEntry> = {}): PlaybackQueueEntry {
  return {
    ...track(id),
    queueId: `q-${id}`,
    queueLane: 'generated',
    queueSource: 'auto_mode',
    ...over,
  };
}

const idleAuto: AutoModeState = {
  active: false,
  profile: 'balanced',
  djProfile: 'adaptive',
  direction: { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] },
  sources: [],
  heard: [],
  avoidedIdentities: [],
  transition: { status: 'idle' },
  pendingDirection: false,
  repairing: false,
  phase: 'idle',
  activity: null,
  plan: {},
  staleSeams: [],
};

function input(over: Partial<PlaybackSessionInput> = {}): PlaybackSessionInput {
  return {
    queue: [entry('a'), entry('b'), entry('c')],
    index: 1,
    shuffle: false,
    repeat: 'off',
    radioMode: false,
    radioSeedId: null,
    auto: idleAuto,
    ...over,
  };
}

const autoSession = (over: Partial<AutoModeState> = {}): AutoModeState => ({
  ...idleAuto,
  active: true,
  profile: 'explore',
  djProfile: 'long_blend',
  direction: { energy: 2, familiarity: -1, prompt: 'darker', include: ['a'], exclude: ['b'] },
  sources: [{ id: 's1', label: 'Björk', tracks: [track('x')], activation: 1 }],
  heard: [track('a')],
  avoidedIdentities: ['music:youtube:zzz'],
  plan: {
    'q-b': { trackId: 'b', source: 'related', reasonKey: 'autoMode.reason.library', fromKey: 'a' },
  },
  staleSeams: ['q-c'],
  ...over,
});

describe('playback session snapshots', () => {
  it('carries the queue, the place in it and the transport the session owns', () => {
    const snapshot = buildPlaybackSession(input({ shuffle: true, repeat: 'all' }))!;

    expect(snapshot.v).toBe(PLAYBACK_SESSION_VERSION);
    expect(snapshot.mode).toBe('now_playing');
    expect(snapshot.queue.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(snapshot.index).toBe(1);
    expect(snapshot.shuffle).toBe(true);
    expect(snapshot.repeat).toBe('all');
    expect(snapshot.auto).toBeNull();
  });

  it('has nothing to describe without a queue', () => {
    expect(buildPlaybackSession(input({ queue: [], index: -1 }))).toBeNull();
  });

  it('carries the whole Auto workspace when Auto is the one driving', () => {
    const auto = autoSession();
    const snapshot = buildPlaybackSession(input({ auto }))!;

    expect(snapshot.mode).toBe('auto');
    expect(snapshot.auto).toEqual({
      profile: 'explore',
      djProfile: 'long_blend',
      direction: auto.direction,
      sources: auto.sources,
      heard: auto.heard,
      avoidedIdentities: auto.avoidedIdentities,
      plan: auto.plan,
      staleSeams: ['q-c'],
    });
  });

  it('drops route entries about occurrences that did not travel', () => {
    const auto = autoSession({
      plan: {
        'q-b': { trackId: 'b', source: 'related', reasonKey: 'r', fromKey: 'a' },
        'q-gone': { trackId: 'gone', source: 'local', reasonKey: 'r', fromKey: 'b' },
      },
      staleSeams: ['q-c', 'q-gone'],
    });

    const snapshot = buildPlaybackSession(input({ auto }))!;

    expect(Object.keys(snapshot.auto!.plan)).toEqual(['q-b']);
    expect(snapshot.auto!.staleSeams).toEqual(['q-c']);
  });

  it('keeps a window around the current entry rather than a whole history', () => {
    const queue = Array.from({ length: 120 }, (_, i) => entry(`t${i}`));
    const snapshot = buildPlaybackSession(input({ queue, index: 100 }))!;

    // A few behind, the current one, and a runway deeper than the planner keeps.
    expect(snapshot.queue[0].id).toBe('t95');
    expect(snapshot.queue.at(-1)!.id).toBe('t119');
    expect(snapshot.queue[snapshot.index].id).toBe('t100');
  });

  it('keeps the direction most recently steered towards when the tray overflows', () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      label: `Source ${i}`,
      tracks: Array.from({ length: 40 }, (_, n) => track(`s${i}-t${n}`)),
      activation: i,
    }));

    const snapshot = buildPlaybackSession(input({ auto: autoSession({ sources }) }))!;

    expect(snapshot.auto!.sources).toHaveLength(6);
    expect(snapshot.auto!.sources[0].id).toBe('s11');
    expect(snapshot.auto!.sources[0].tracks).toHaveLength(15);
  });

  it('survives the round trip through the engine', () => {
    const snapshot = buildPlaybackSession(input({ auto: autoSession(), repeat: 'one' }))!;

    expect(readPlaybackSession(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('refuses anything that is not a session it knows how to rebuild', () => {
    const snapshot = buildPlaybackSession(input())!;

    expect(readPlaybackSession(null)).toBeNull();
    expect(readPlaybackSession('resume me')).toBeNull();
    expect(readPlaybackSession({ ...snapshot, v: 99 })).toBeNull();
    expect(readPlaybackSession({ ...snapshot, queue: [] })).toBeNull();
    expect(readPlaybackSession({ ...snapshot, queue: [{ title: 'no id' }] })).toBeNull();
  });

  it('reads an out-of-range index as the head of what did arrive', () => {
    const snapshot = buildPlaybackSession(input())!;

    expect(readPlaybackSession({ ...snapshot, index: 9 })?.index).toBe(0);
    expect(readPlaybackSession({ ...snapshot, index: -3 })?.index).toBe(0);
  });

  it('is Now Playing when a snapshot claims Auto without a workspace', () => {
    const snapshot = buildPlaybackSession(input())!;

    const restored = readPlaybackSession({ ...snapshot, mode: 'auto', auto: null })!;

    expect(restored.mode).toBe('now_playing');
    expect(restored.auto).toBeNull();
  });

  it('repairs a workspace that arrived with unusable pieces', () => {
    const snapshot = buildPlaybackSession(input({ auto: autoSession() }))!;

    const restored = readPlaybackSession({
      ...snapshot,
      auto: {
        ...snapshot.auto,
        profile: 'wildcard',
        djProfile: 'freestyle',
        direction: null,
        sources: [{ id: 's-empty', label: 'Empty', tracks: [], activation: 1 }],
        heard: 'not a list',
        plan: { 'q-b': { fromKey: 'a' } },
        staleSeams: ['q-c', 'q-missing'],
      },
    })!;

    expect(restored.auto).toEqual({
      profile: 'balanced',
      djProfile: 'adaptive',
      direction: { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] },
      sources: [],
      heard: [],
      avoidedIdentities: ['music:youtube:zzz'],
      plan: {},
      staleSeams: ['q-c'],
    });
  });
});
