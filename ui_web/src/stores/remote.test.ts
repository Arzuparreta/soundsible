import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../lib/api';
import { WEB_REMOTE_COMMANDS } from '../lib/deviceIdentity';
import { createQueueEntry, type PlaybackQueueEntry } from '../lib/playbackQueue';
import type { PlaybackSessionSnapshot } from '../lib/playbackSession';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import type { AppSocket, DeviceStateEvent, WatchDeviceAck } from '../lib/socket';
import type { Track } from '../types/music';
import type { PlayerActions } from './contracts';
import { resetAccountState, setState, state } from './core';
import { isPlayingTrack, isQueuedTrack } from './identity';
import {
  applyDeviceState,
  attachRemoteSocket,
  heldPosition,
  projectAutoMode,
  projectPlayback,
  refreshDevices,
  remoteActionsFor,
  remoteAutoMode,
  remoteCan,
  remotePending,
  remotePlayback,
  remoteTarget,
  remoteUnreachable,
  resetRemoteState,
  retryTarget,
  selectTarget,
  sendCommand,
  transferTo,
  type HeldState,
} from './remote';

const mocks = vi.hoisted(() => ({ listDevices: vi.fn(), deviceCommand: vi.fn(), transfer: vi.fn(), toastError: vi.fn() }));
vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, listDevices: mocks.listDevices, deviceCommand: mocks.deviceCommand, transfer: mocks.transfer } };
});
vi.mock('../lib/toast', () => ({ toast: { error: mocks.toastError, info: vi.fn(), success: vi.fn(), action: vi.fn() } }));

const t1: Track = { id: 't1', title: 'One', artist: 'A', duration: 200 };
const t2: Track = { id: 't2', title: 'Two', artist: 'B', duration: 180 };
const t3: Track = { id: 't3', title: 'Three', artist: 'C', duration: 220 };
const entry = (track: Track, queueId: string, lane: 'context' | 'manual' | 'generated' = 'context'): PlaybackQueueEntry =>
  ({ ...createQueueEntry(track, lane, lane === 'manual' ? 'add_to_queue' : lane === 'generated' ? 'auto_mode' : 'album'), queueId });
const session = (queue: PlaybackQueueEntry[], extra: Partial<PlaybackSessionSnapshot> = {}): PlaybackSessionSnapshot =>
  ({ v: 1, mode: 'now_playing', queue, index: 0, shuffle: false, repeat: 'off', radio: { active: false, seedId: null }, auto: null, ...extra });
const device = (over: Partial<Device> = {}): Device => ({
  device_id: 'speaker', device_name: 'Speaker', device_type: 'web', form_factor: 'computer',
  online: true, protocol: 1, commands: [...WEB_REMOTE_COMMANDS], playing: null, ...over,
});
const live = { phase: 'playing' as const, duration: 200, volume: { level: 0.6, muted: false }, dj: null };
const stateEvent = (over: Partial<DeviceStateEvent> = {}): DeviceStateEvent => ({
  device_id: 'speaker', rev: 1, track_id: 't1', track: t1, position_sec: 10, is_playing: true,
  measured_at_ms: Date.now(), live, server_now_ms: Date.now(), ...over,
});

function socket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emitted: { event: string; payload: unknown; ack?: (answer: WatchDeviceAck) => void }[] = [];
  const s = {
    connected: false,
    on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn),
    emit: (event: string, payload: unknown, ack?: (answer: WatchDeviceAck) => void) => emitted.push({ event, payload, ack }),
  } as unknown as AppSocket;
  const lifetime = new RuntimeLifetime();
  lifetime.start();
  attachRemoteSocket(s, lifetime);
  return { emitted, fire: (event: string, payload: unknown) => handlers.get(event)?.(payload), lifetime };
}

async function controlSpeaker(rows: Device[] = [device()]) {
  mocks.listDevices.mockResolvedValue({ devices: rows, server_now_ms: Date.now() });
  const io = socket();
  await refreshDevices();
  selectTarget('speaker');
  return io;
}

beforeEach(() => {
  localStorage.clear();
  resetAccountState();
  resetRemoteState();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 0 });
});
afterEach(() => vi.useRealTimers());

describe('held state', () => {
  it('ignores states whose rev is not newer, and keeps the session when an event carries none', async () => {
    await controlSpeaker();
    const queue = [entry(t1, 'a'), entry(t2, 'b')];
    applyDeviceState(stateEvent({ rev: 5, session: session(queue, { shuffle: true }) }));
    expect(remotePlayback.queue.map((e) => e.queueId)).toEqual(['a', 'b']);
    expect(remotePlayback.shuffle).toBe(true);

    applyDeviceState(stateEvent({ rev: 5, is_playing: false }));
    applyDeviceState(stateEvent({ rev: 4, is_playing: false }));
    expect(remotePlayback.isPlaying).toBe(true);

    applyDeviceState(stateEvent({ rev: 6, is_playing: false }));
    expect(remotePlayback.isPlaying).toBe(false);
    expect(remotePlayback.queue.map((e) => e.queueId)).toEqual(['a', 'b']);

    applyDeviceState(stateEvent({ rev: 7, session: null }));
    expect(remotePlayback.queue.map((e) => e.queueId)).toHaveLength(1);
    expect(remotePlayback.currentTrack?.id).toBe('t1');
  });

  it('interpolates the position with the server clock offset and clamps it to the duration', () => {
    const held: HeldState = { rev: 1, track: t1, positionSec: 40, isPlaying: true, measuredAtMs: 1_000_000, offsetMs: 2_000, live, session: null };
    // The server is 2 s ahead: 3 s after the measurement on its clock is 1 s here.
    expect(heldPosition(held, 200, 1_001_000)).toBeCloseTo(43);
    expect(heldPosition(held, 41, 1_001_000)).toBe(41);
    expect(heldPosition({ ...held, isPlaying: false }, 200, 1_001_000)).toBe(40);
  });

  it('starts from the row and takes the watch acknowledgement with the session at the same rev', async () => {
    const playing = { track: t2, is_playing: true, position_sec: 3, measured_at_ms: Date.now(), mode: 'normal' as const, rev: 9 };
    const io = await controlSpeaker([device({ playing })]);
    expect(remotePlayback.currentTrack?.id).toBe('t2');
    const watch = io.emitted.find((e) => e.event === 'watch_device')!;
    expect(watch.payload).toEqual({ device_id: 'speaker' });
    watch.ack!({ device: device({ playing }), server_now_ms: Date.now(), state: stateEvent({ rev: 9, track: t2, track_id: 't2', session: session([entry(t2, 'x'), entry(t3, 'y')]) }) });
    expect(remotePlayback.queue.map((e) => e.queueId)).toEqual(['x', 'y']);
  });
});

describe('projection', () => {
  it('builds PlaybackState and AutoModeState from the session and live state, with neutral local-only fields', () => {
    const queue = [entry(t1, 'a'), entry(t2, 'b', 'generated')];
    const held: HeldState = {
      rev: 1, track: t1, positionSec: 0, isPlaying: true, measuredAtMs: 0, offsetMs: 0,
      live: { ...live, phase: 'buffering', dj: { phase: 'ready', repairing: true, pending_direction: false, mixing: true, transition: { status: 'armed', at: 150 } } },
      session: session(queue, { mode: 'auto', repeat: 'one', auto: { profile: 'balanced', sources: [], heard: [], avoidedIdentities: [], plan: {}, staleSeams: ['b'] } }),
    };
    expect(projectPlayback(held, false)).toMatchObject({
      currentTrack: { id: 't1' }, index: 0, isPlaying: true, isLoading: true, phase: 'buffering', loadError: false,
      previewPreparation: null, duration: 200, repeat: 'one', volume: 0.6, muted: false, djMixing: true, autoplayEnabled: false,
    });
    expect(projectPlayback(held, false, 0.2).volume).toBe(0.2);
    expect(projectPlayback(held, true)).toMatchObject({ isPlaying: false, isLoading: false, phase: 'paused' });
    expect(projectAutoMode(held)).toMatchObject({ active: true, repairing: true, phase: 'ready', staleSeams: ['b'], transition: { status: 'armed', at: 150 } });
    expect(projectAutoMode({ ...held, live: { ...live, dj: null } }).active).toBe(false);
    expect(projectPlayback(null, false)).toMatchObject({ currentTrack: null, queue: [], index: -1, phase: 'idle' });
  });

  it('marks the controlled device’s songs in lists, and this device’s again once it is chosen', async () => {
    setState('playback', { currentTrack: entry(t3, 'local'), queue: [entry(t3, 'local')], index: 0 });
    expect(isPlayingTrack(t3)).toBe(true);
    await controlSpeaker();
    applyDeviceState(stateEvent({ rev: 1, session: session([entry(t1, 'a'), entry(t2, 'b', 'manual')]) }));
    expect(isPlayingTrack(t1)).toBe(true);
    expect(isQueuedTrack(t2)).toBe(true);
    expect(isPlayingTrack(t3)).toBe(false);
    selectTarget(null);
    expect(isPlayingTrack(t3)).toBe(true);
  });
});

describe('commands', () => {
  it('keeps a control pending until the state reaches the answer’s rev, at most 3 s', async () => {
    vi.useFakeTimers();
    await controlSpeaker();
    applyDeviceState(stateEvent({ rev: 1 }));
    mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 2 });
    await sendCommand('transport.pause', {}, 'play');
    expect(remotePending('play')).toBe(true);
    applyDeviceState(stateEvent({ rev: 2, is_playing: false }));
    expect(remotePending('play')).toBe(false);

    mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 3 });
    await sendCommand('transport.play', {}, 'play');
    expect(remotePending('play')).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(remotePending('play')).toBe(false);
  });

  it('shows a seek and a volume until the device confirms them', async () => {
    await controlSpeaker();
    applyDeviceState(stateEvent({ rev: 1, position_sec: 10 }));
    let answer!: (value: unknown) => void;
    mocks.deviceCommand.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const actions = remoteActionsFor({} as PlayerActions);
    actions.seek(90);
    actions.setVolume(0.3);
    expect(remotePlayback.currentTime).toBe(90);
    expect(remotePlayback.volume).toBe(0.3);
    answer({ status: 'applied', rev: 2 });
    await Promise.resolve();
    applyDeviceState(stateEvent({ rev: 2, position_sec: 90, live: { ...live, volume: { level: 0.3, muted: false } } }));
    expect(remotePending('seek')).toBe(false);
  });

  it('says why a command was not applied, and an offline answer makes the device unreachable', async () => {
    await controlSpeaker();
    mocks.deviceCommand.mockResolvedValue({ status: 'rejected', reason: 'locked' });
    expect(await sendCommand('queue.move', { queue_id: 'x' })).toBe(false);
    expect(mocks.toastError).toHaveBeenLastCalledWith('That song is already mixing in');
    mocks.deviceCommand.mockResolvedValue({ status: 'unreachable', reason: 'offline' });
    await sendCommand('transport.play', {}, 'play');
    expect(mocks.toastError).toHaveBeenLastCalledWith('Speaker is not reachable');
    expect(remoteUnreachable()).toBe(true);
    expect(remoteTarget()).toBe('speaker');
  });

  it('sends every player action to the controlled device as its command', async () => {
    await controlSpeaker();
    const queue = [entry(t1, 'a'), entry(t2, 'b', 'manual'), entry(t3, 'c', 'manual')];
    applyDeviceState(stateEvent({ rev: 1, session: session(queue, { repeat: 'all' }) }));
    const local = { toggleFavouriteTrack: vi.fn() } as unknown as PlayerActions;
    const actions = remoteActionsFor(local);
    const sent = async (run: () => unknown) => {
      mocks.deviceCommand.mockClear();
      await run();
      await Promise.resolve();
      return mocks.deviceCommand.mock.calls.map(([, name, args]) => [name, args]);
    };
    expect(await sent(() => actions.togglePlay())).toEqual([['transport.pause', {}]]);
    expect(await sent(() => actions.next())).toEqual([['transport.next', {}]]);
    expect(await sent(() => actions.autoSkip())).toEqual([['transport.next', {}]]);
    expect(await sent(() => actions.prev())).toEqual([['transport.previous', {}]]);
    expect(await sent(() => actions.seekBy(5))).toEqual([['transport.seek', { position_sec: expect.closeTo(15, 0) }]]);
    expect(await sent(() => actions.toggleShuffle())).toEqual([['transport.set_shuffle', { on: true }]]);
    expect(await sent(() => actions.cycleRepeat())).toEqual([['transport.set_repeat', { mode: 'one' }]]);
    expect(await sent(() => actions.toggleMute())).toEqual([['transport.set_muted', { on: true }]]);
    expect(await sent(() => actions.jumpTo(2))).toEqual([['queue.play_entry', { queue_id: 'c' }]]);
    expect(await sent(() => actions.moveInQueue(2, 1))).toEqual([['queue.move', { queue_id: 'c', before_queue_id: 'b' }]]);
    expect(await sent(() => actions.moveInQueue(1, 2))).toEqual([['queue.move', { queue_id: 'b' }]]);
    expect(await sent(() => actions.removeFromQueue(1))).toEqual([['queue.remove', { queue_id: 'b' }]]);
    expect(await sent(() => actions.playFrom([t1, t2], 1, { context: { id: 'al', kind: 'album', label: 'Al' } })))
      .toEqual([['play.tracks', { tracks: [t1, t2], index: 1, context: { id: 'al', kind: 'album', label: 'Al' } }]]);
    expect(await sent(() => actions.playTrack(t3))).toEqual([['play.tracks', { tracks: [t3], index: 0 }]]);
    expect(await sent(() => actions.playNext(t3))).toEqual([['queue.add', { track: t3, at: 'next' }]]);
    expect(await sent(() => actions.enqueue(t3))).toEqual([['queue.add', { track: t3, at: 'end' }]]);
    expect(await sent(() => actions.startRadio(t1))).toEqual([['radio.start', { track: t1 }]]);
    expect(await sent(() => actions.startDjSelection([t1, t2], 'Mix'))).toEqual([['dj.start', { tracks: [t1, t2], label: 'Mix' }]]);
    expect(await sent(() => actions.enterAutoMode())).toEqual([['dj.start_from_current', {}]]);
    expect(await sent(() => actions.enterAutoMode({ source: t1, deferPlanning: true }))).toEqual([]);
    expect(await sent(() => actions.exitAutoMode())).toEqual([['dj.stop', {}]]);
    expect(await sent(() => actions.placeAutoTrack(t3, 'b'))).toEqual([['dj.place', { tracks: [t3], before_queue_id: 'b' }]]);
    expect(await sent(() => actions.addAutoSource([t2], 'Two'))).toEqual([['dj.add_source', { tracks: [t2], label: 'Two' }]]);
    expect(await sent(() => actions.removeAutoSource('s1'))).toEqual([['dj.remove_source', { source_id: 's1' }]]);
    expect(await sent(() => actions.changeAutoSession([t1], 'One'))).toEqual([['dj.change_session', { tracks: [t1], label: 'One' }]]);
    expect(await sent(() => actions.repairAutoRoute())).toEqual([['dj.repair', {}]]);
    expect(await sent(() => actions.promoteInAutoRoute('c'))).toEqual([['dj.promote', { queue_id: 'c' }]]);
    expect(await sent(() => actions.avoidAutoTrackForSession('c'))).toEqual([['dj.avoid', { queue_id: 'c' }]]);
    expect(await sent(() => actions.moveAutoRoute('c', 'b'))).toEqual([['queue.move', { queue_id: 'c', before_queue_id: 'b' }]]);
    expect(await sent(() => actions.setDjMixing(false))).toEqual([['dj.set_mixing', { on: false }]]);
    // Play now keeps the queue: next in line, then skip to it.
    expect(await sent(async () => { actions.playNow(t3); await Promise.resolve(); await Promise.resolve(); }))
      .toEqual([['queue.add', { track: t3, at: 'next' }], ['transport.next', {}]]);
    // Nothing that is not playback goes anywhere.
    actions.toggleFavouriteTrack(t1);
    expect(local.toggleFavouriteTrack).toHaveBeenCalledWith(t1);
    expect(remoteAutoMode.active).toBe(false);
  });

  it('asks the controlled device which optional controls it has', async () => {
    expect(remoteCan('transport.set_volume')).toBe(true);
    await controlSpeaker([device({ commands: ['transport.play', 'transport.pause'] })]);
    expect(remoteCan('transport.set_volume')).toBe(false);
    expect(remoteCan('transport.play')).toBe(true);
  });
});

describe('target', () => {
  it('ignores a previously saved web target and active remote playback on a fresh page', async () => {
    localStorage.setItem('remote:target', 'speaker');
    const playing = { track: t1, is_playing: true, position_sec: 1, measured_at_ms: Date.now(), mode: 'normal' as const, rev: 1 };
    mocks.listDevices.mockResolvedValue({ devices: [device({ playing })] });
    socket();
    await refreshDevices();
    expect(remoteTarget()).toBeNull();
    selectTarget('speaker');
    await refreshDevices();
    expect(remoteTarget()).toBe('speaker');
    resetRemoteState();
    socket();
    await refreshDevices();
    expect(remoteTarget()).toBeNull();
  });

  it('says when the controlled device goes offline, and offers it again only when it is back', async () => {
    const io = await controlSpeaker();
    io.fire('device_updated', { device: device({ online: false }) });
    expect(remoteUnreachable()).toBe(true);
    expect(remoteTarget()).toBe('speaker');
    mocks.listDevices.mockResolvedValue({ devices: [device({ online: false })] });
    expect(await retryTarget()).toBe(false);
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    expect(await retryTarget()).toBe(true);
    expect(remoteUnreachable()).toBe(false);
    expect(io.emitted.filter((e) => e.event === 'watch_device')).toHaveLength(2);
  });

  it('moves the session and then controls wherever it went', async () => {
    await controlSpeaker();
    mocks.transfer.mockResolvedValue({ status: 'applied', rev: 3 });
    expect(await transferTo('speaker', state.device.device_id)).toBe(true);
    expect(remoteTarget()).toBeNull();
    mocks.transfer.mockResolvedValue({ status: 'rejected', reason: 'nothing_playing', step: 'export' });
    expect(await transferTo(state.device.device_id, 'speaker')).toBe(false);
    expect(mocks.toastError).toHaveBeenLastCalledWith(`Nothing is playing on ${state.device.device_name}`);
  });
});
