import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEB_REMOTE_COMMANDS } from '../lib/deviceIdentity';
import { createQueueEntry, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import type { Track } from '../types/music';
import { resetAccountState, setState, state } from './core';
import { createRemoteCommandExecutor, type RemoteCommandPorts } from './remoteCommands';

const t1: Track = { id: 't1', title: 'One', artist: 'Artist', duration: 180 };
const t2: Track = { id: 't2', title: 'Two', artist: 'Artist', duration: 200 };
const t3: Track = { id: 't3', title: 'Three', artist: 'Artist', duration: 210 };
const pod: Track = { id: 'ep1', title: 'Ep', artist: 'Show', media_kind: 'podcast_episode', podcast_enclosure_url: 'https://example.com/ep.mp3' };

function makeEntry(track: Track, queueId: string, lane: 'manual' | 'context' | 'generated' = 'manual', autoRoute?: PlaybackQueueEntry['autoRoute']): PlaybackQueueEntry {
  return {
    ...createQueueEntry(track, lane, lane === 'generated' ? 'auto_mode' : lane === 'manual' ? 'add_to_queue' : 'album'),
    queueId,
    autoRoute,
  };
}

function createHarness(overrides: Partial<RemoteCommandPorts> = {}) {
  const lifetime = new RuntimeLifetime();
  lifetime.start();
  const actions: RemoteCommandPorts['actions'] = {
    resumePlayback: vi.fn(),
    pausePlayback: vi.fn(),
    autoSkip: vi.fn().mockResolvedValue(undefined),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
    toggleShuffle: vi.fn(() => setState('playback', 'shuffle', s => !s)),
    cycleRepeat: vi.fn(() => setState('playback', 'repeat', r => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))),
    setVolume: vi.fn(),
    toggleMute: vi.fn(() => setState('playback', 'muted', m => !m)),
    playFrom: vi.fn(),
    playTrack: vi.fn(),
    playNext: vi.fn(),
    enqueue: vi.fn(),
    moveAutoRoute: vi.fn(),
    moveInQueue: vi.fn(),
    removeAutoRouteOccurrence: vi.fn(),
    removeQueueEntry: vi.fn(),
    playQueueEntry: vi.fn(),
    startRadio: vi.fn().mockResolvedValue(undefined),
    stopRadio: vi.fn(),
    startDjSelection: vi.fn().mockReturnValue(true),
    enterAutoMode: vi.fn(() => setState('autoMode', 'active', true)),
    exitAutoMode: vi.fn(() => setState('autoMode', 'active', false)),
    placeAutoTracks: vi.fn().mockResolvedValue(undefined),
    promoteInAutoRoute: vi.fn(),
    avoidAutoTrackForSession: vi.fn(),
    addAutoSource: vi.fn(),
    removeAutoSource: vi.fn(),
    changeAutoSession: vi.fn().mockResolvedValue(true),
    repairAutoRoute: vi.fn().mockResolvedValue(undefined),
    setDjMixing: vi.fn().mockResolvedValue(true),
  };
  let rev = 10;
  let committed: string | null = null;
  let startPromise: Promise<void> = Promise.resolve();
  const pushPlaybackState = vi.fn().mockImplementation(async () => ++rev);
  const playbackStateBody = vi.fn((override?: { position_sec?: number; includeSession?: boolean }) => ({
    track_id: state.playback.currentTrack?.id ?? null,
    track: state.playback.currentTrack,
    position_sec: override?.position_sec ?? state.playback.currentTime,
    is_playing: state.playback.isPlaying,
    device_id: state.device.device_id,
    device_name: state.device.device_name,
    device_type: 'web',
    instance_id: state.device.instance_id,
    seq: 7,
    live: { phase: 'playing' as const, duration: 180, volume: { level: 1, muted: false }, dj: null },
    ...(override?.includeSession ? { session: { v: 1 as const, mode: 'now_playing' as const, queue: state.playback.queue, index: state.playback.index, shuffle: false, repeat: 'off' as const, radio: { active: false, seedId: null }, auto: null } } : {}),
  }));
  const ports: RemoteCommandPorts = {
    actions,
    committedQueueId: () => committed,
    startSettled: () => startPromise,
    pushPlaybackState,
    playbackStateBody,
    livePosition: () => 55.5,
    lastRev: () => rev,
    sessionFor: vi.fn().mockReturnValue(null),
    playRestoredSession: vi.fn().mockReturnValue(true),
    ...overrides,
  };
  const executor = createRemoteCommandExecutor(ports, lifetime);
  return {
    executor,
    actions,
    ports,
    pushPlaybackState,
    playbackStateBody,
    lifetime,
    setCommitted: (id: string | null) => { committed = id; },
    setStartPromise: (p: Promise<void>) => { startPromise = p; },
  };
}

beforeEach(() => {
  localStorage.clear();
  resetAccountState();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await vi.dynamicImportSettled();
});

describe('remoteCommands executor', () => {
  it('declares exactly the commands implemented in the handler table', () => {
    const h = createHarness();
    expect([...WEB_REMOTE_COMMANDS].sort()).toEqual([...h.executor.commands].sort());
    h.lifetime.close();
  });

  it('maps every normal-mode command to its PlayerActions function and acknowledges after publishing with rev', async () => {
    const h = createHarness();
    const q0 = makeEntry(t1, 'q0', 'context');
    const q1 = makeEntry(t2, 'q1', 'manual');
    const q2 = makeEntry(t3, 'q2', 'manual');
    setState('playback', { currentTrack: q0, queue: [q0, q1, q2], index: 0, isPlaying: true, shuffle: false, repeat: 'off' });

    expect(await h.executor.execute({ name: 'transport.play' })).toEqual({ status: 'applied', rev: 11 });
    expect(h.actions.resumePlayback).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'transport.pause' })).toEqual({ status: 'applied', rev: 12 });
    expect(h.actions.pausePlayback).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'transport.next' })).toEqual({ status: 'applied', rev: 13 });
    expect(h.actions.next).toHaveBeenCalledTimes(1);
    expect(h.actions.autoSkip).not.toHaveBeenCalled();

    expect(await h.executor.execute({ name: 'transport.previous' })).toEqual({ status: 'applied', rev: 14 });
    expect(h.actions.prev).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'transport.seek', args: { position_sec: 42.5 } })).toEqual({ status: 'applied', rev: 15 });
    expect(h.actions.seek).toHaveBeenCalledWith(42.5);

    expect(await h.executor.execute({ name: 'transport.set_shuffle', args: { on: true } })).toEqual({ status: 'applied', rev: 16 });
    expect(h.actions.toggleShuffle).toHaveBeenCalledTimes(1);
    // Already true -> no toggle.
    expect(await h.executor.execute({ name: 'transport.set_shuffle', args: { on: true } })).toEqual({ status: 'applied', rev: 17 });
    expect(h.actions.toggleShuffle).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'transport.set_repeat', args: { mode: 'one' } })).toEqual({ status: 'applied', rev: 18 });
    expect(h.actions.cycleRepeat).toHaveBeenCalledTimes(2);
    expect(state.playback.repeat).toBe('one');

    expect(await h.executor.execute({ name: 'transport.set_volume', args: { level: 0.4 } })).toEqual({ status: 'applied', rev: 19 });
    expect(h.actions.setVolume).toHaveBeenCalledWith(0.4);

    expect(await h.executor.execute({ name: 'transport.set_muted', args: { on: true } })).toEqual({ status: 'applied', rev: 20 });
    expect(h.actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(state.playback.muted).toBe(true);
    // Already muted -> no toggle.
    expect(await h.executor.execute({ name: 'transport.set_muted', args: { on: true } })).toEqual({ status: 'applied', rev: 21 });
    expect(h.actions.toggleMute).toHaveBeenCalledTimes(1);

    const ctx = { id: 'alb:1', kind: 'album', label: 'Album' };
    expect(await h.executor.execute({ name: 'play.tracks', args: { tracks: [t1, t2], index: 1, context: ctx } })).toEqual({ status: 'applied', rev: 22 });
    expect(h.actions.playFrom).toHaveBeenCalledWith([t1, t2], 1, { context: ctx });

    expect(await h.executor.execute({ name: 'queue.add', args: { track: t3, at: 'next' } })).toEqual({ status: 'applied', rev: 23 });
    expect(h.actions.playNext).toHaveBeenCalledWith(t3);

    expect(await h.executor.execute({ name: 'queue.add', args: { track: t3, at: 'end' } })).toEqual({ status: 'applied', rev: 24 });
    expect(h.actions.enqueue).toHaveBeenCalledWith(t3);

    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q2', before_queue_id: 'q1' } })).toEqual({ status: 'applied', rev: 25 });
    expect(h.actions.moveInQueue).toHaveBeenCalledWith(2, 1);

    // Move q1 to end of manual section (no before_queue_id).
    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q1' } })).toEqual({ status: 'applied', rev: 26 });
    expect(h.actions.moveInQueue).toHaveBeenCalledWith(1, 2);

    expect(await h.executor.execute({ name: 'queue.remove', args: { queue_id: 'q1' } })).toEqual({ status: 'applied', rev: 27 });
    expect(h.actions.removeQueueEntry).toHaveBeenCalledWith('q1');

    expect(await h.executor.execute({ name: 'queue.play_entry', args: { queue_id: 'q2' } })).toEqual({ status: 'applied', rev: 28 });
    expect(h.actions.playQueueEntry).toHaveBeenCalledWith('q2');

    expect(await h.executor.execute({ name: 'radio.start', args: { track: t1 } })).toEqual({ status: 'applied', rev: 29 });
    expect(h.actions.startRadio).toHaveBeenCalledWith(t1);

    expect(await h.executor.execute({ name: 'radio.stop' })).toEqual({ status: 'applied', rev: 30 });
    expect(h.actions.stopRadio).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'dj.set_mixing', args: { on: false } })).toEqual({ status: 'applied', rev: 31 });
    expect(h.actions.setDjMixing).toHaveBeenCalledWith(false);

    expect(await h.executor.execute({ name: 'dj.start_from_current' })).toEqual({ status: 'applied', rev: 32 });
    expect(h.actions.enterAutoMode).toHaveBeenCalledTimes(1);

    h.lifetime.close();
  });

  it('maps every DJ-mode command and routes queue edits to DJ route functions', async () => {
    const h = createHarness();
    const q0 = makeEntry(t1, 'q0', 'generated', { kind: 'generated' });
    const q1 = makeEntry(t2, 'q1', 'generated', { kind: 'generated' });
    const q2 = makeEntry(t3, 'q2', 'generated', { kind: 'user' });
    setState('playback', { currentTrack: q0, queue: [q0, q1, q2], index: 0, isPlaying: true });
    setState('autoMode', {
      active: true,
      sources: [
        { id: 's1', label: 'Src 1', tracks: [t1], activation: 1 },
        { id: 's2', label: 'Src 2', tracks: [t2], activation: 2 },
      ],
      transition: { status: 'idle' },
    });

    expect(await h.executor.execute({ name: 'transport.next' })).toEqual({ status: 'applied', rev: 11 });
    expect(h.actions.autoSkip).toHaveBeenCalledTimes(1);
    expect(h.actions.next).not.toHaveBeenCalled();

    expect(await h.executor.execute({ name: 'play.tracks', args: { tracks: [t2], index: 0 } })).toEqual({ status: 'applied', rev: 12 });
    expect(h.actions.playFrom).toHaveBeenCalledWith([t2], 0, undefined);

    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q2', before_queue_id: 'q1' } })).toEqual({ status: 'applied', rev: 13 });
    expect(h.actions.moveAutoRoute).toHaveBeenCalledWith('q2', 'q1');
    expect(h.actions.moveInQueue).not.toHaveBeenCalled();

    expect(await h.executor.execute({ name: 'queue.remove', args: { queue_id: 'q2' } })).toEqual({ status: 'applied', rev: 14 });
    expect(h.actions.removeAutoRouteOccurrence).toHaveBeenCalledWith('q2');
    expect(h.actions.removeQueueEntry).not.toHaveBeenCalled();

    expect(await h.executor.execute({ name: 'dj.start', args: { tracks: [t1, t2], label: 'Set' } })).toEqual({ status: 'applied', rev: 15 });
    expect(h.actions.startDjSelection).toHaveBeenCalledWith([t1, t2], 'Set');

    expect(await h.executor.execute({ name: 'dj.place', args: { tracks: [t3], before_queue_id: 'q2' } })).toEqual({ status: 'applied', rev: 16 });
    expect(h.actions.placeAutoTracks).toHaveBeenCalledWith([t3], 'q2');

    expect(await h.executor.execute({ name: 'dj.promote', args: { queue_id: 'q2' } })).toEqual({ status: 'applied', rev: 17 });
    expect(h.actions.promoteInAutoRoute).toHaveBeenCalledWith('q2');

    expect(await h.executor.execute({ name: 'dj.avoid', args: { queue_id: 'q2' } })).toEqual({ status: 'applied', rev: 18 });
    expect(h.actions.avoidAutoTrackForSession).toHaveBeenCalledWith('q2');

    expect(await h.executor.execute({ name: 'dj.add_source', args: { tracks: [t3], label: 'Ambient' } })).toEqual({ status: 'applied', rev: 19 });
    expect(h.actions.addAutoSource).toHaveBeenCalledWith([t3], 'Ambient');

    expect(await h.executor.execute({ name: 'dj.remove_source', args: { source_id: 's2' } })).toEqual({ status: 'applied', rev: 20 });
    expect(h.actions.removeAutoSource).toHaveBeenCalledWith('s2');

    expect(await h.executor.execute({ name: 'dj.change_session', args: { tracks: [t2], label: 'New' } })).toEqual({ status: 'applied', rev: 21 });
    expect(h.actions.changeAutoSession).toHaveBeenCalledWith([t2], 'New');

    expect(await h.executor.execute({ name: 'dj.repair' })).toEqual({ status: 'applied', rev: 22 });
    expect(h.actions.repairAutoRoute).toHaveBeenCalledTimes(1);

    expect(await h.executor.execute({ name: 'dj.stop' })).toEqual({ status: 'applied', rev: 23 });
    expect(h.actions.exitAutoMode).toHaveBeenCalledTimes(1);

    h.lifetime.close();
  });

  it('waits for publication to settle before acknowledging with its rev', async () => {
    let finishPublish!: (rev: number) => void;
    const h = createHarness({
      pushPlaybackState: vi.fn().mockImplementation(() => new Promise<number>(resolve => { finishPublish = resolve; })),
    });
    const q0 = makeEntry(t1, 'q0', 'context');
    setState('playback', { currentTrack: q0, queue: [q0], index: 0, isPlaying: true });

    let settled = false;
    const pending = h.executor.execute({ name: 'transport.pause' }).then(res => { settled = true; return res; });
    await Promise.resolve();
    expect(h.actions.pausePlayback).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishPublish(42);
    expect(await pending).toEqual({ status: 'applied', rev: 42 });
    h.lifetime.close();
  });

  it('rejects every error reason: unsupported, invalid, nothing_playing, invalid_state, not_found, locked, needs_gesture', async () => {
    const h = createHarness();

    // unsupported
    expect(await h.executor.execute({ name: 'future.command' })).toEqual({ status: 'rejected', reason: 'unsupported' });

    // invalid args
    expect(await h.executor.execute({ name: 'transport.seek', args: { position_sec: 'bad' } })).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(await h.executor.execute({ name: 'transport.set_volume', args: { level: 2 } })).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(await h.executor.execute({ name: 'transport.set_muted', args: { on: 'yes' } })).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(await h.executor.execute({ name: 'transport.set_repeat', args: { mode: 'twice' } })).toEqual({ status: 'rejected', reason: 'invalid' });

    // nothing_playing when idle
    expect(await h.executor.execute({ name: 'transport.play' })).toEqual({ status: 'rejected', reason: 'nothing_playing' });
    expect(await h.executor.execute({ name: 'transport.pause' })).toEqual({ status: 'rejected', reason: 'nothing_playing' });
    expect(await h.executor.execute({ name: 'transport.seek', args: { position_sec: 10 } })).toEqual({ status: 'rejected', reason: 'nothing_playing' });
    expect(await h.executor.execute({ name: 'session.export' })).toEqual({ status: 'rejected', reason: 'nothing_playing' });

    // dj.* commands while DJ mode is off
    for (const cmd of [
      { name: 'dj.stop' },
      { name: 'dj.place', args: { tracks: [t1] } },
      { name: 'dj.promote', args: { queue_id: 'q1' } },
      { name: 'dj.avoid', args: { queue_id: 'q1' } },
      { name: 'dj.add_source', args: { tracks: [t1], label: 'L' } },
      { name: 'dj.remove_source', args: { source_id: 's1' } },
      { name: 'dj.change_session', args: { tracks: [t1], label: 'L' } },
      { name: 'dj.repair' },
    ]) {
      expect(await h.executor.execute(cmd)).toEqual({ status: 'rejected', reason: 'invalid_state' });
    }

    // not_found for missing queue_id / before_queue_id / source_id
    const q0 = makeEntry(t1, 'q0', 'context');
    const q1 = makeEntry(t2, 'q1', 'generated', { kind: 'bridge', ownerQueueId: 'q2' });
    const q2 = makeEntry(t3, 'q2', 'generated', { kind: 'user' });
    const q3 = makeEntry(t1, 'q3', 'generated', { kind: 'generated' });
    setState('playback', { currentTrack: q0, queue: [q0, q1, q2, q3], index: 0, isPlaying: true });
    expect(await h.executor.execute({ name: 'queue.remove', args: { queue_id: 'gone' } })).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(await h.executor.execute({ name: 'queue.play_entry', args: { queue_id: 'gone' } })).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q1', before_queue_id: 'gone' } })).toEqual({ status: 'rejected', reason: 'not_found' });

    // Cross-section move in normal mode -> invalid_state
    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q0', before_queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'invalid_state' });

    // locked in DJ mode when entry is armed (including owner of armed bridge)
    setState('autoMode', {
      active: true,
      sources: [{ id: 's1', label: 'Only', tracks: [t1], activation: 1 }],
      transition: { status: 'armed', at: 150 },
    });
    h.setCommitted('q1');
    expect(await h.executor.execute({ name: 'queue.remove', args: { queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'locked' });
    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q1', before_queue_id: 'q3' } })).toEqual({ status: 'rejected', reason: 'locked' });
    expect(await h.executor.execute({ name: 'queue.move', args: { queue_id: 'q3', before_queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'locked' });
    expect(await h.executor.execute({ name: 'dj.promote', args: { queue_id: 'q2' } })).toEqual({ status: 'rejected', reason: 'locked' });
    expect(await h.executor.execute({ name: 'dj.avoid', args: { queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'locked' });
    expect(await h.executor.execute({ name: 'dj.place', args: { tracks: [t2], before_queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'locked' });

    // locked when mixing
    setState('autoMode', 'transition', { status: 'mixing' });
    setState('playback', 'index', 1);
    expect(await h.executor.execute({ name: 'queue.remove', args: { queue_id: 'q1' } })).toEqual({ status: 'rejected', reason: 'locked' });

    // remove_source not_found & last source invalid_state
    expect(await h.executor.execute({ name: 'dj.remove_source', args: { source_id: 'missing' } })).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(await h.executor.execute({ name: 'dj.remove_source', args: { source_id: 's1' } })).toEqual({ status: 'rejected', reason: 'invalid_state' });

    // radio.start with podcast -> invalid_state
    expect(await h.executor.execute({ name: 'radio.start', args: { track: pod } })).toEqual({ status: 'rejected', reason: 'invalid_state' });

    // needs_gesture when browser refuses playback
    h.actions.resumePlayback = vi.fn(() => { setState('playback', 'needsGesture', true); });
    expect(await h.executor.execute({ name: 'transport.play' })).toEqual({ status: 'rejected', reason: 'needs_gesture' });
    setState('playback', 'needsGesture', false);

    // action throwing -> invalid_state
    h.actions.pausePlayback = vi.fn(() => { throw new Error('boom'); });
    expect(await h.executor.execute({ name: 'transport.pause' })).toEqual({ status: 'rejected', reason: 'invalid_state' });

    h.lifetime.close();
  });

  it('handles session.export, session.import (playing, needs_gesture, 9s timeout) and session.release', async () => {
    const h = createHarness();
    const q0 = makeEntry(t1, 'q0', 'context');
    setState('playback', { currentTrack: q0, queue: [q0], index: 0, isPlaying: true, currentTime: 12 });

    const exported = await h.executor.execute({ name: 'session.export' });
    expect(exported).toMatchObject({ status: 'applied', rev: 10, state: { track_id: 't1', position_sec: 55.5 } });
    expect(h.playbackStateBody).toHaveBeenCalledWith({ position_sec: 55.5, includeSession: true });

    // session.release pauses, publishes, and acks with rev.
    expect(await h.executor.execute({ name: 'session.release' })).toEqual({ status: 'applied', rev: 11 });
    expect(h.actions.pausePlayback).toHaveBeenCalledTimes(1);

    // session.import waits until audio is playing before publishing and acknowledging.
    const restoredSession = {
      v: 1 as const, mode: 'now_playing' as const, queue: [q0], index: 0,
      shuffle: false, repeat: 'off' as const, radio: { active: false, seedId: null }, auto: null,
    };
    (h.ports.sessionFor as ReturnType<typeof vi.fn>).mockReturnValue(restoredSession);
    (h.ports.playRestoredSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setState('playback', { phase: 'loading', needsGesture: false, loadError: false });
      return true;
    });
    let resolved = false;
    const imp = h.executor.execute({
      name: 'session.import',
      args: { state: { track_id: 't1', track: t1, position_sec: 30, session: restoredSession } },
    }).then(r => { resolved = true; return r; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    setState('playback', 'phase', 'playing');
    expect(await imp).toEqual({ status: 'applied', rev: 12 });

    // session.import rejects with needs_gesture when autoplay is blocked.
    const impGesture = h.executor.execute({
      name: 'session.import',
      args: { state: { track_id: 't1', track: t1, position_sec: 0, session: restoredSession } },
    });
    await Promise.resolve();
    setState('playback', { needsGesture: true, phase: 'paused' });
    expect(await impGesture).toEqual({ status: 'rejected', reason: 'needs_gesture' });

    // session.import rejects with invalid_state after 9 s timeout.
    vi.useFakeTimers();
    const impTimeout = h.executor.execute({
      name: 'session.import',
      args: { state: { track_id: 't1', track: t1, position_sec: 0, session: restoredSession } },
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(await impTimeout).toEqual({ status: 'rejected', reason: 'invalid_state' });

    h.lifetime.close();
  });
});

describe('registration, seq, live state and debounced session publishing', () => {
  async function loadStoreHarness(apiOverrides: Record<string, unknown> = {}) {
    vi.resetModules();
    const putPlaybackState = vi.fn().mockImplementation(() => Promise.resolve({ status: 'ok', rev: ++revCounter }));
    let revCounter = 0;
    const registerDevice = vi.fn().mockResolvedValue(undefined);
    const socketEmit = vi.fn();
    const socketHandlers = new Map<string, (...args: unknown[]) => void>();
    const deckHandlers = new Map<string, ((snapshot: unknown, event: Event) => void)[]>();
    const audioService = {
      load: vi.fn().mockResolvedValue(undefined),
      recover: vi.fn().mockResolvedValue(undefined),
      prime: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      seek: vi.fn(),
      bufferedEnd: vi.fn(() => 0),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      getVolume: vi.fn(() => 0.8),
      unlockAudio: vi.fn(() => false),
      graphReady: vi.fn(() => false),
      stage: vi.fn(),
      clearStaged: vi.fn(),
      takeStaged: vi.fn(() => null),
      mixPhase: vi.fn(() => 'idle' as const),
      mixIsDominant: vi.fn(() => false),
      cancelMix: vi.fn(),
      startMixNow: vi.fn(() => false),
      armTransition: vi.fn().mockResolvedValue(undefined),
      setLevels: vi.fn(),
      setLevelingEnabled: vi.fn(),
      levelingEnabled: vi.fn(() => true),
      snapshot: vi.fn(() => ({
        playing: true, sourcePlaying: true, position: 12, duration: 180, playbackRate: 1,
        ended: false, readyState: 4, networkState: 1, mediaErrorCode: 0, hasSource: true,
        bufferedEnd: 0, activeIndex: 0, mixPhase: 'idle' as const, dominant: false, contextState: 'unavailable',
      })),
    };
    const api = {
      registerDevice,
      putPlaybackState,
      getPlaybackState: vi.fn().mockResolvedValue(undefined),
      getLibrary: vi.fn().mockResolvedValue({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getSaved: vi.fn().mockResolvedValue([]),
      getSavedEntities: vi.fn().mockResolvedValue([]),
      getDiscoverySettings: vi.fn().mockResolvedValue({}),
      getDiscoveryMusicFeed: vi.fn().mockResolvedValue({ items: [] }),
      getDownloads: vi.fn().mockResolvedValue({ queue: [], is_processing: false }),
      getLibraryAlbums: vi.fn().mockResolvedValue([]),
      getLibraryArtists: vi.fn().mockResolvedValue([]),
      getLibraryGenres: vi.fn().mockResolvedValue([]),
      getLibraryYears: vi.fn().mockResolvedValue([]),
      sendPlayTiming: vi.fn().mockResolvedValue({ status: 'ok' }),
      sendPlaybackTrace: vi.fn().mockResolvedValue({ id: '1', enabled: false }),
      emitDiscoveryEvent: vi.fn().mockResolvedValue({}),
      setDjMixing: vi.fn().mockResolvedValue({}),
      planDjQueue: vi.fn().mockResolvedValue({ items: [], pool_counts: { local: 0, related: 0, discovery: 0 } }),
      planMusicQueue: vi.fn().mockResolvedValue({ items: [], pool_counts: { local: 0, related: 0, discovery: 0 } }),
      ...apiOverrides,
    };
    vi.doMock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api, request: vi.fn().mockResolvedValue({}) }));
    vi.doMock('../lib/session', () => ({ user: () => ({ id: 'u1', username: 'u' }), setUser: vi.fn() }));
    vi.doMock('../lib/savedEntities', () => ({ syncSavedEntities: vi.fn().mockResolvedValue(undefined), resetSavedEntities: vi.fn() }));
    vi.doMock('../lib/audio', () => ({
      audioService,
      disposeAudio: vi.fn(),
      storedVolume: () => 0.8,
      onProgramEvent: vi.fn((type: string, fn: (snapshot: unknown, event: Event) => void) => {
        const list = deckHandlers.get(type) ?? [];
        list.push(fn);
        deckHandlers.set(type, list);
        return () => {};
      }),
      setProgramTransportReporter: vi.fn(),
    }));
    vi.doMock('../lib/socket', () => ({
      createSocket: vi.fn(() => ({
        on: (event: string, fn: (...args: unknown[]) => void) => socketHandlers.set(event, fn),
        emit: socketEmit,
        disconnect: vi.fn(),
        connect: vi.fn(),
        connected: false,
      })),
    }));
    const store = await import('./index');
    return {
      store,
      api,
      socketEmit,
      fireSocket: (event: string, ...args: unknown[]) => socketHandlers.get(event)?.(...args),
      fireDeck: (type: string) => { for (const fn of deckHandlers.get(type) ?? []) fn(audioService.snapshot(), new Event(type)); },
    };
  }

  it('registers with instance_id, form_factor, protocol 1, commands, device_type web, and preserves stored device_name', async () => {
    localStorage.setItem('device_name', 'Studio Monitor');
    const h = await loadStoreHarness();
    h.store.initStore();
    h.fireSocket('connect');
    expect(h.socketEmit).toHaveBeenCalledWith('playback_register', expect.objectContaining({
      device_name: 'Studio Monitor',
      device_type: 'web',
      form_factor: expect.stringMatching(/^(phone|tablet|computer)$/),
      instance_id: expect.any(String),
      protocol: 1,
      commands: [...WEB_REMOTE_COMMANDS],
    }));
    expect(h.api.registerDevice).toHaveBeenCalledWith(expect.objectContaining({
      device_name: 'Studio Monitor',
      device_type: 'web',
      instance_id: h.store.state.device.instance_id,
      protocol: 1,
      commands: [...WEB_REMOTE_COMMANDS],
    }));
    h.store.disposeStore();
  });

  it('publishes increasing seq, live state, and debounces session changes within 250 ms without firing on timeupdate', async () => {
    vi.useFakeTimers();
    const h = await loadStoreHarness();
    h.store.initStore();
    h.store.actions.playFrom([t1, t2], 0);
    h.fireDeck('playing');
    h.store.actions.seek(15);
    await vi.advanceTimersByTimeAsync(0);

    const first = h.api.putPlaybackState.mock.calls.at(-1)![0];
    expect(first.instance_id).toBe(h.store.state.device.instance_id);
    expect(first.seq).toBe(1);
    expect(first.live).toEqual({
      phase: 'playing',
      duration: 0,
      volume: { level: 1, muted: false },
      dj: null,
    });

    h.api.putPlaybackState.mockClear();
    // timeupdate must NOT trigger the debounced session publish.
    h.fireDeck('timeupdate');
    await vi.advanceTimersByTimeAsync(300);
    expect(h.api.putPlaybackState).not.toHaveBeenCalled();

    // Two quick session edits coalesce into one publish within 250 ms.
    h.store.actions.enqueue(t3);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.api.putPlaybackState).not.toHaveBeenCalled();
    h.store.actions.toggleShuffle();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.api.putPlaybackState).toHaveBeenCalledTimes(1);
    const second = h.api.putPlaybackState.mock.calls[0][0];
    expect(second.seq).toBe(2);
    expect(second.session.shuffle).toBe(true);
    expect(second.session.queue).toHaveLength(3);

    // Entering DJ mode publishes live.dj within 250 ms.
    h.api.putPlaybackState.mockClear();
    h.store.actions.enterAutoMode();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.api.putPlaybackState).toHaveBeenCalledTimes(1);
    const third = h.api.putPlaybackState.mock.calls[0][0];
    expect(third.seq).toBe(3);
    expect(third.live.dj).toMatchObject({
      repairing: false,
      pending_direction: false,
      mixing: true,
      transition: { status: 'idle' },
    });

    h.store.disposeStore();
  });

  it('answers a DJ route move with the rev of a publication that already carries the moved route', async () => {
    const h = await loadStoreHarness();
    h.store.initStore();
    const core = await import('./core');
    const [q0, q1, q2, q3] = [t1, t2, t3, { ...t1, id: 't4' }].map((track, i) =>
      makeEntry(track, `q${i}`, 'generated', { kind: 'generated' }));
    core.setState('playback', { currentTrack: q0, queue: [q0, q1, q2, q3], index: 0, isPlaying: true, phase: 'playing' });
    core.setState('autoMode', { active: true, phase: 'ready', transition: { status: 'idle' } });
    h.api.putPlaybackState.mockClear();

    const ack = vi.fn();
    h.fireSocket('device_command', { name: 'queue.move', args: { queue_id: 'q3', before_queue_id: 'q1' } }, ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalled());

    const [published] = h.api.putPlaybackState.mock.calls.at(-1)!;
    expect(published.session.queue.map((entry: PlaybackQueueEntry) => entry.queueId)).toEqual(['q0', 'q3', 'q1', 'q2']);
    const rev = await h.api.putPlaybackState.mock.results.at(-1)!.value;
    expect(ack).toHaveBeenCalledWith({ status: 'applied', rev: rev.rev });
    h.store.disposeStore();
  });

  it('does not rebuild or stringify the session snapshot on volume or phase changes', async () => {
    vi.useFakeTimers();
    const buildSpy = vi.fn();
    vi.doMock('../lib/playbackSession', async (orig) => {
      const mod = await orig<typeof import('../lib/playbackSession')>();
      return {
        ...mod,
        buildPlaybackSession: (...args: Parameters<typeof mod.buildPlaybackSession>) => {
          buildSpy();
          return mod.buildPlaybackSession(...args);
        },
      };
    });
    const h = await loadStoreHarness();
    h.store.initStore();
    h.store.actions.playFrom([t1, t2], 0);
    h.fireDeck('playing');
    await vi.advanceTimersByTimeAsync(250);

    buildSpy.mockClear();
    h.api.putPlaybackState.mockClear();

    // Dragging volume should only track live state, never rebuild the session snapshot.
    h.store.actions.setVolume(0.5);
    h.store.actions.setVolume(0.4);
    h.store.actions.setVolume(0.3);
    await vi.advanceTimersByTimeAsync(250);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(h.api.putPlaybackState).toHaveBeenCalledTimes(1);
    const volCall = h.api.putPlaybackState.mock.calls[0][0];
    expect(volCall.live.volume.level).toBe(0.3);
    expect('session' in volCall).toBe(false);

    h.store.disposeStore();
  });

  it('rejects excluded DJ, radio, and volume commands and omits live.volume in TV mode', async () => {
    vi.useFakeTimers();
    const { TV_REMOTE_COMMANDS } = await import('../lib/deviceIdentity');
    const h = await loadStoreHarness();
    h.store.initStore({
      desktopShortcuts: false,
      remoteCommands: TV_REMOTE_COMMANDS,
    });
    h.store.actions.playFrom([t1, t2], 0);
    h.fireDeck('playing');
    await vi.advanceTimersByTimeAsync(250);

    expect(h.api.putPlaybackState).toHaveBeenCalled();
    const published = h.api.putPlaybackState.mock.calls.at(-1)![0];
    expect(published.live.volume).toBeUndefined();

    // Volume / radio / DJ commands are rejected as unsupported on TV receivers.
    const sendCmd = async (name: string, args: Record<string, unknown>) => {
      const ack = vi.fn();
      h.fireSocket('device_command', { name, args }, ack);
      await vi.waitFor(() => expect(ack).toHaveBeenCalled());
      return ack.mock.calls[0][0];
    };
    const ackVol = await sendCmd('transport.set_volume', { level: 0.4 });
    const ackRadio = await sendCmd('radio.start', { track: t1 });
    const ackDj = await sendCmd('dj.start_from_current', {});
    expect(ackVol).toEqual({ status: 'rejected', reason: 'unsupported' });
    expect(ackRadio).toEqual({ status: 'rejected', reason: 'unsupported' });
    expect(ackDj).toEqual({ status: 'rejected', reason: 'unsupported' });

    // Supported playback command still executes cleanly.
    const ackNext = await sendCmd('transport.next', {});
    expect(ackNext.status).toBe('applied');

    h.store.disposeStore();
  });

  it('skips desktop shortcut handler when desktopShortcuts is false and re-emits registration on rename', async () => {
    vi.useFakeTimers();
    const h = await loadStoreHarness();
    h.store.initStore({ desktopShortcuts: false });
    h.fireSocket('connect');
    h.store.actions.playFrom([t1, t2], 0);
    h.fireDeck('playing');
    await vi.advanceTimersByTimeAsync(250);

    const beforePaused = h.store.state.playback.isPlaying;
    // Desktop Space shortcut should not toggle playback when desktopShortcuts is false.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(h.store.state.playback.isPlaying).toBe(beforePaused);

    h.api.registerDevice.mockClear();
    h.store.actions.setDeviceName('Media Room TV');
    await vi.advanceTimersByTimeAsync(150);
    expect(h.api.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({ device_name: 'Media Room TV' }),
    );

    h.store.disposeStore();
  });
});
