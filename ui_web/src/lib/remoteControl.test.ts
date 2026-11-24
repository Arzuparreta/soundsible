import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from './api';
import { createRemoteControl, type RemoteHost } from './remoteControl';
import type { DeviceStateEvent, WatchDeviceAck } from './socket';

const mocks = vi.hoisted(() => ({ listDevices: vi.fn(), deviceCommand: vi.fn(), transfer: vi.fn(), toastError: vi.fn() }));
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, listDevices: mocks.listDevices, deviceCommand: mocks.deviceCommand, transfer: mocks.transfer } };
});
vi.mock('./toast', () => ({ toast: { error: mocks.toastError } }));

const song = { id: 't1', title: 'One', artist: 'A', duration: 200 };
const device = (over: Partial<Device> = {}): Device => ({
  device_id: 'speaker', device_name: 'Speaker', device_type: 'web', form_factor: 'computer',
  online: true, protocol: 1, commands: ['transport.play', 'transport.pause'], playing: null, ...over,
});
const playing = { track: song, is_playing: true, position_sec: 4, measured_at_ms: Date.now(), mode: 'normal' as const, rev: 2 };
const stateEvent = (over: Partial<DeviceStateEvent> = {}): DeviceStateEvent => ({
  device_id: 'speaker', rev: 3, track_id: 't1', track: song, position_sec: 10, is_playing: true, measured_at_ms: Date.now(), live: null, ...over,
});

/** The Android app's shape: a host that is not the web player and a link that is not a socket. */
function setup(host: Partial<RemoteHost> = {}) {
  const watches: { id: string; ack: (answer: WatchDeviceAck | null | undefined) => void }[] = [];
  const unwatched: string[] = [];
  const control = createRemoteControl({ selfId: () => 'phone', selfName: () => 'Pixel', ...host });
  control.attach({ watch: (id, ack) => watches.push({ id, ack }), unwatch: id => unwatched.push(id) });
  return { control, watches, unwatched };
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('shared remote control with an injected link', () => {
  it('starts local even with active playback or a remembered choice and rewatches only an explicit target', async () => {
    localStorage.setItem('test:target', 'speaker');
    mocks.listDevices.mockResolvedValue({ devices: [device({ playing })], server_now_ms: Date.now() });
    const { control, watches } = setup();
    await control.refreshDevices();
    expect(control.target()).toBeNull();
    expect(watches).toEqual([]);

    control.selectTarget('speaker');
    control.onConnect();
    expect(watches.map(w => w.id)).toEqual(['speaker', 'speaker']);
    expect(control.target()).toBe('speaker');
    control.reset();
    await control.refreshDevices();
    expect(control.target()).toBeNull();
  });

  it('projects the current track position using server time without sending a command', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    mocks.listDevices.mockResolvedValue({
      devices: [device({ playing: { ...playing, position_sec: 20, measured_at_ms: 88000 } })],
      server_now_ms: 90000,
    });
    const { control, watches } = setup();
    await control.refreshDevices();
    vi.setSystemTime(11000);
    expect(control.trackCopy('speaker')).toEqual({ track: playing.track, positionSec: 23 });
    expect(watches).toEqual([]);
    expect(mocks.deviceCommand).not.toHaveBeenCalled();
    expect(control.target()).toBeNull();
    control.deviceUpdated(device({ online: false, playing }));
    expect(control.trackCopy('speaker')).toBeNull();
  });

  it('takes the watch acknowledgement, keeps rev order, and treats choosing itself as this device', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const { control, watches } = setup();
    await control.refreshDevices();
    control.selectTarget('speaker');
    watches[0].ack({ device: device(), state: stateEvent({ rev: 5 }), server_now_ms: Date.now() });
    expect(control.held()?.rev).toBe(5);
    control.applyDeviceState(stateEvent({ rev: 4, is_playing: false }));
    expect(control.held()?.isPlaying).toBe(true);
    control.selectTarget('phone');
    expect(control.target()).toBeNull();
    expect(control.controlledName()).toBe('Pixel');
  });

  it('watches again when a device that went offline comes back', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const { control, watches } = setup();
    await control.refreshDevices();
    control.selectTarget('speaker');
    control.deviceUpdated(device({ online: false }));
    expect(control.unreachable()).toBe(true);
    control.deviceUpdated(device());
    expect(watches.map(w => w.id)).toEqual(['speaker', 'speaker']);
  });

  it('with confirm, resolves a command only once the state carrying its rev arrives', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const { control, watches } = setup();
    await control.refreshDevices();
    control.selectTarget('speaker');
    watches[0].ack({ device: device(), state: stateEvent({ rev: 1 }) });
    mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 2 });
    let done = false;
    const sent = control.sendCommand('transport.pause', {}, undefined, undefined, true).then(ok => { done = ok; });
    await vi.waitFor(() => expect(mocks.deviceCommand).toHaveBeenCalledWith('speaker', 'transport.pause', {}));
    await Promise.resolve();
    expect(done).toBe(false);
    control.applyDeviceState(stateEvent({ rev: 2, is_playing: false }));
    await sent;
    expect(done).toBe(true);
  });

  it('gives up waiting after 3 s, and says why a command failed with this device’s names', async () => {
    vi.useFakeTimers();
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const { control } = setup();
    await control.refreshDevices();
    control.selectTarget('speaker');
    mocks.deviceCommand.mockResolvedValue({ status: 'applied', rev: 9 });
    const sent = control.sendCommand('transport.play', {}, 'play', undefined, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await sent).toBe(true);
    mocks.deviceCommand.mockResolvedValue({ status: 'rejected', reason: 'unsupported' });
    expect(await control.sendCommand('dj.promote', { queue_id: 'x' })).toBe(false);
    expect(mocks.toastError).toHaveBeenLastCalledWith("Speaker can't do that");
    mocks.transfer.mockResolvedValue({ status: 'rejected', reason: 'nothing_playing', step: 'export' });
    expect(await control.transferTo('phone', 'speaker')).toBe(false);
    expect(mocks.toastError).toHaveBeenLastCalledWith('Nothing is playing on Pixel');
  });

  it('forgets the account’s devices and target on reset', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [device()] });
    const { control } = setup();
    await control.refreshDevices();
    control.selectTarget('speaker');
    control.reset();
    expect([control.target(), control.devices(), control.held()]).toEqual([null, null, null]);
  });
});
