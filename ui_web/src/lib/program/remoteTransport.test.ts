import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../api';
import type { PlaybackQueueEntry } from '../playbackQueue';
import type { PlaybackSessionSnapshot } from '../playbackSession';
import { createRemoteControl, type HeldState } from '../remoteControl';
import type { DeviceStateEvent } from '../socket';
import type { Track } from '../../types/music';
import { contractCommands, createRemoteProgramTransport, projectProgram, RemoteProgramUnsupported } from './remoteTransport';
import { createProgramRuntime, offers, type ProgramState } from './runtime';

const mocks = vi.hoisted(() => ({ listDevices: vi.fn(), deviceCommand: vi.fn(), toastError: vi.fn() }));
vi.mock('../api', async (orig) => {
  const actual = await orig<typeof import('../api')>();
  return { ...actual, api: { ...actual.api, listDevices: mocks.listDevices, deviceCommand: mocks.deviceCommand } };
});
vi.mock('../toast', () => ({ toast: { error: mocks.toastError } }));

const ALL = ['transport.play', 'transport.pause', 'transport.next', 'transport.previous', 'transport.seek', 'transport.set_shuffle',
  'transport.set_repeat', 'play.tracks', 'queue.add', 'queue.move', 'queue.remove', 'queue.play_entry', 'radio.start', 'radio.stop',
  'dj.start', 'dj.start_from_current', 'dj.stop', 'dj.place', 'dj.add_source', 'dj.remove_source', 'dj.repair', 'dj.set_mixing'];
const t1: Track = { id: 't1', title: 'One', artist: 'A', duration: 200 };
const t2: Track = { id: 't2', title: 'Two', artist: 'B', duration: 180 };
const t3: Track = { id: 't3', title: 'Three', artist: 'C', duration: 220 };
const entry = (track: Track, queueId: string, lane: PlaybackQueueEntry['queueLane'] = 'context', source: PlaybackQueueEntry['queueSource'] = 'album'): PlaybackQueueEntry =>
  ({ ...track, queueId, queueLane: lane, queueSource: source });
const session = (queue: PlaybackQueueEntry[], extra: Partial<PlaybackSessionSnapshot> = {}): PlaybackSessionSnapshot =>
  ({ v: 1, mode: 'now_playing', queue, index: 0, shuffle: false, repeat: 'off', radio: { active: false, seedId: null }, auto: null, ...extra });
const held = (over: Partial<HeldState> = {}): HeldState => ({
  rev: 1, track: t1, positionSec: 30, isPlaying: true, measuredAtMs: 1000, offsetMs: 0,
  live: { phase: 'playing', duration: 200, dj: null }, session: session([entry(t1, 'a'), entry(t2, 'b', 'manual', 'add_to_queue'), entry(t3, 'c')]), ...over,
});

describe('the controlled device as a ProgramState', () => {
  it('names occurrences by queue_id and carries transport, lanes and the controls the device declares', () => {
    const { state } = projectProgram(held({ session: session([entry(t1, 'a'), entry(t2, 'b', 'manual'), entry(t3, 'c', 'generated', 'radio')], { index: 1, repeat: 'one', shuffle: true }) }),
      'speaker', false, ['transport.play', 'transport.seek', 'queue.add'], 7);
    expect(state).toMatchObject({
      generation: 7, ready: true, playing: true, playWhenReady: true, index: 1, id: 't2', title: 'Two', durationMs: 200_000,
      repeat: 1, shuffle: true, hasNext: true, hasPrevious: true, state: 3, queueToken: 'remote:speaker', seekable: true,
    });
    expect(state.items.map(i => [i.key, i.lane, i.generatedSource])).toEqual([['a', 'context', null], ['b', 'manual', null], ['c', 'generated', 'radio']]);
    expect(state.controls).toEqual(['seek', 'queueAdd']);
    expect(offers(state, 'stop')).toBe(false);
    expect(offers(state, 'autoplay')).toBe(false);
    expect(offers(state, 'queueEdit')).toBe(false);
    // A native program sets no list: it offers everything.
    expect(offers({ controls: undefined }, 'stop')).toBe(true);
  });

  it('shows the DJ route with its armed entry protected and its sources', () => {
    const sources = [{ id: 's1', label: 'Mix', tracks: [t1], activation: 1 }];
    const { state } = projectProgram(held({
      live: { phase: 'playing', duration: 200, dj: { phase: 'ready', repairing: false, pending_direction: false, mixing: true, transition: { status: 'armed', next_queue_id: 'b', at: 180 } } },
      session: session([entry(t1, 'a'), entry(t2, 'b', 'generated', 'auto_mode')], { mode: 'auto', auto: { profile: 'balanced', sources, heard: [], avoidedIdentities: [], plan: {}, staleSeams: [] } }),
    }), 'speaker', false, ALL, 1);
    expect(state.dj).toMatchObject({ active: true, phase: 'ready', editableFrom: 2, protectedKeys: ['b'], sources });
    expect(state.hasNext).toBe(true);
  });

  it('is not ready while the device is unreachable, and shows a single song without a session', () => {
    const { state } = projectProgram(held({ session: null, live: null }), 'speaker', true, ALL, 1);
    expect(state).toMatchObject({ ready: false, playing: false, index: 0, id: 't1', dj: null });
    expect(state.items).toHaveLength(1);
    expect(projectProgram(null, null, false, [], 1).state).toMatchObject({ ready: false, index: -1, items: [] });
  });
});

describe('ProgramCommands as contract commands', () => {
  const view = projectProgram(held(), 'speaker', false, ALL, 1);
  const send = (command: Parameters<typeof contractCommands>[0]) => contractCommands(command, view, 30);
  const base = { queueToken: 'remote:speaker' };
  it('maps transport, queue, radio and DJ commands', () => {
    expect(send({ action: 'pause' })).toEqual([['transport.pause', {}]]);
    expect(send({ action: 'next' })).toEqual([['transport.next', {}]]);
    expect(send({ action: 'previous' })).toEqual([['transport.previous', {}]]);
    expect(send({ action: 'seek', positionMs: 90_500 })).toEqual([['transport.seek', { position_sec: 90.5 }]]);
    expect(send({ action: 'skip', seconds: -15, index: 0, key: 'a', ...base })).toEqual([['transport.seek', { position_sec: 15 }]]);
    expect(send({ action: 'shuffle', enabled: true })).toEqual([['transport.set_shuffle', { on: true }]]);
    expect(send({ action: 'repeat', mode: 2 })).toEqual([['transport.set_repeat', { mode: 'all' }]]);
    expect(send({ action: 'select', index: 2, key: 'c', ...base })).toEqual([['queue.play_entry', { queue_id: 'c' }]]);
    expect(send({ action: 'remove', index: 1, key: 'b', ...base })).toEqual([['queue.remove', { queue_id: 'b' }]]);
    // Moving the request down lands it before nothing in its own section: at the end of it.
    expect(send({ action: 'move', index: 1, toIndex: 2, key: 'b', ...base })).toEqual([['queue.move', { queue_id: 'b' }]]);
    expect(send({ action: 'move', index: 2, toIndex: 1, key: 'c', ...base })).toEqual([['queue.move', { queue_id: 'c' }]]);
    expect(send({ action: 'clearManual', ...base })).toEqual([['queue.remove', { queue_id: 'b' }]]);
    const local = { source: 'local' as const, id: 't3', title: 'Three', artist: 'C' };
    expect(send({ action: 'append', tracks: [local], ...base })).toEqual([['queue.add', { track: expect.objectContaining({ id: 't3' }), at: 'end' }]]);
    expect(send({ action: 'insertAfter', tracks: [local, { ...local, id: 't2' }], index: 0, key: 'a', ...base }).map(([, args]) => (args.track as Track).id)).toEqual(['t2', 't3']);
    expect(send({ action: 'queue', tracks: [local, { ...local, id: 't1' }], index: 1 })).toEqual([['play.tracks', { tracks: [expect.objectContaining({ id: 't3' }), expect.objectContaining({ id: 't1' })], index: 1 }]]);
    expect(send({ action: 'radio', enabled: true, profile: 'balanced', ...base })).toEqual([['radio.start', { track: expect.objectContaining({ id: 't1' }) }]]);
    expect(send({ action: 'radio', enabled: false, profile: 'balanced', ...base })).toEqual([['radio.stop', {}]]);
    expect(send({ action: 'dj', fromCurrent: true, ...base })).toEqual([['dj.start_from_current', {}]]);
    expect(send({ action: 'djSelection', tracks: [local], label: 'Mix', ...base })).toEqual([['dj.start', { tracks: [expect.objectContaining({ id: 't3' })], label: 'Mix' }]]);
    expect(send({ action: 'djRequest', tracks: [local], beforeKey: 'c', programToken: 'p', ...base })).toEqual([['dj.place', { tracks: [expect.objectContaining({ id: 't3' })], before_queue_id: 'c' }]]);
    expect(send({ action: 'djRepair', programToken: 'p', ...base })).toEqual([['dj.repair', {}]]);
    expect(send({ action: 'mixing', enabled: false })).toEqual([['dj.set_mixing', { on: false }]]);
  });

  it('turns a DJ source list into the sources it adds and removes', () => {
    const dj = projectProgram(held({ live: { phase: 'playing', duration: 200, dj: { phase: 'ready', repairing: false, pending_direction: false, mixing: true, transition: { status: 'idle' } } },
      session: session([entry(t1, 'a')], { mode: 'auto', auto: { profile: 'balanced', sources: [{ id: 's1', label: 'Old', tracks: [t1], activation: 1 }], heard: [], avoidedIdentities: [], plan: {}, staleSeams: [] } }) }), 'speaker', false, ALL, 1);
    expect(contractCommands({ action: 'djSettings', programToken: 'p', sources: [{ id: 's2', label: 'New', tracks: [t2], activation: 2 }] }, dj, 0))
      .toEqual([['dj.remove_source', { source_id: 's1' }], ['dj.add_source', { tracks: [expect.objectContaining({ id: 't2' })], label: 'New' }]]);
  });

  it('refuses what only this device can do', () => {
    for (const command of [{ action: 'stop', ...base }, { action: 'autoplay', enabled: true }, { action: 'leveling', enabled: true }, { action: 'retireSource', id: 'x' }] as const) {
      expect(() => send(command)).toThrow(RemoteProgramUnsupported);
    }
  });
});

describe('the remote transport in the program runtime', () => {
  const device = (over: Partial<Device> = {}): Device => ({ device_id: 'speaker', device_name: 'Speaker', online: true, protocol: 1, commands: ALL, playing: null, ...over });
  const event = (over: Partial<DeviceStateEvent> = {}): DeviceStateEvent => ({
    device_id: 'speaker', rev: 1, track_id: 't1', track: t1, position_sec: 30, is_playing: true, measured_at_ms: Date.now(),
    live: { phase: 'playing', duration: 200, dj: null }, session: session([entry(t1, 'a'), entry(t2, 'b')]), server_now_ms: Date.now(), ...over,
  });
  beforeEach(() => { localStorage.clear(); for (const mock of Object.values(mocks)) mock.mockReset(); });

  it('stays pending until the device publishes the answer’s rev, then shows that state', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const control = createRemoteControl({ selfId: () => 'phone', selfName: () => 'Pixel', hasMusic: () => true, storageKey: 'k' });
    control.attach({ watch: (_id, ack) => ack({ device: device(), state: event() }), unwatch: () => {} });
    await control.refreshDevices();
    control.selectTarget('speaker');
    const states: (ProgramState | null)[] = [];
    const pending: boolean[] = [];
    const runtime = createProgramRuntime(createRemoteProgramTransport(control, () => 3), { state: s => states.push(s), pending: p => pending.push(p), error: () => {} });
    await runtime.bind(3);
    expect(states.at(-1)).toMatchObject({ generation: 3, ready: true, playWhenReady: true, index: 0, items: [{ key: 'a' }, { key: 'b' }] });

    mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 2 });
    const done = runtime.execute({ action: 'select', index: 1, key: 'b', queueToken: 'remote:speaker' });
    await vi.waitFor(() => expect(mocks.deviceCommand).toHaveBeenCalledWith('speaker', 'queue.play_entry', { queue_id: 'b' }));
    expect(pending.at(-1)).toBe(true);
    control.applyDeviceState(event({ rev: 2, track: t2, session: session([entry(t1, 'a'), entry(t2, 'b')], { index: 1 }) }));
    await done;
    expect(pending.at(-1)).toBe(false);
    expect(states.at(-1)).toMatchObject({ index: 1, id: 't2' });

    mocks.deviceCommand.mockResolvedValue({ status: 'rejected', reason: 'not_found' });
    await expect(runtime.execute({ action: 'remove', index: 0, key: 'a', queueToken: 'remote:speaker' })).rejects.toThrow();
    expect(mocks.toastError).toHaveBeenLastCalledWith('That song is no longer in the queue');
    runtime.unbind();
  });
});
