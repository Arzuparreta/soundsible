import { createRoot } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Device } from '../lib/api';
import { discardOverlays, OverlayOutlet } from '../lib/overlay';
import type { DeviceStateEvent } from '../lib/socket';
import { openConnectSheet } from '../components/ConnectSheet';
import { createNativeRemote } from './remote';

const mocks = vi.hoisted(() => ({
  watch: vi.fn(), listeners: new Map<string, (event: unknown) => void>(), remove: vi.fn(),
  listDevices: vi.fn(), deviceCommand: vi.fn(), transfer: vi.fn(),
}));
vi.mock('./devices', () => ({ nativeDevices: {
  deviceWatch: mocks.watch,
  addListener: (event: string, callback: (event: unknown) => void) => { mocks.listeners.set(event, callback); return Promise.resolve({ remove: mocks.remove }); },
} }));
vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, listDevices: mocks.listDevices, deviceCommand: mocks.deviceCommand, transfer: mocks.transfer } };
});

const song = { id: 't1', title: 'Midnight City', artist: 'M83', duration: 240 };
const laptop = (over: Partial<Device> = {}): Device => ({
  device_id: 'laptop', device_name: 'Laptop', device_type: 'web', form_factor: 'computer', online: true, protocol: 1, commands: ['transport.play'], playing: null, ...over,
});
const stateEvent = (over: Partial<DeviceStateEvent & { generation: number }> = {}): DeviceStateEvent & { generation: number } => ({
  generation: 4, device_id: 'laptop', rev: 3, track_id: 't1', track: song, position_sec: 1, is_playing: true, measured_at_ms: Date.now(), live: null, ...over,
});

let dispose: () => void = () => {};
function setup(hasMusic = false) {
  return createRoot(done => {
    dispose = done;
    return createNativeRemote({
      generation: () => 4,
      device: () => ({ generation: 4, device_id: 'phone', connected: true, device_name: 'Pixel' }),
      hasMusic: () => hasMusic,
    });
  });
}
const self = (track: typeof song | null) => ({ name: 'Pixel', formFactor: 'phone', deviceType: 'android', track: () => track, playing: () => Boolean(track) });

beforeEach(() => {
  localStorage.clear();
  discardOverlays();
  for (const mock of [mocks.watch, mocks.remove, mocks.listDevices, mocks.deviceCommand, mocks.transfer]) mock.mockReset();
  mocks.listeners.clear();
});
afterEach(() => { dispose(); cleanup(); });

it('watches through the service for this account and takes only this account’s forwarded events', async () => {
  mocks.listDevices.mockResolvedValue({ devices: [laptop({ playing: { track: song, is_playing: true, position_sec: 0, measured_at_ms: 0, mode: 'normal', rev: 2 } })] });
  mocks.watch.mockResolvedValue({ device: laptop(), state: stateEvent({ rev: 2 }) });
  const remote = setup();
  await vi.waitFor(() => expect(mocks.listeners.size).toBe(2));
  expect(remote.label()).toBe('Devices');
  // Startup: this phone has nothing loaded and the laptop is playing.
  await remote.control.refreshDevices();
  expect(mocks.watch).toHaveBeenCalledWith({ generation: 4, device_id: 'laptop' });
  await vi.waitFor(() => expect(remote.control.held()?.rev).toBe(2));
  expect(remote.label()).toBe('Playing on Laptop');

  mocks.listeners.get('device_state')!(stateEvent({ generation: 3, rev: 9, is_playing: false }));
  expect(remote.control.held()?.rev).toBe(2);
  mocks.listeners.get('device_state')!(stateEvent({ rev: 5, is_playing: false }));
  expect(remote.control.held()).toMatchObject({ rev: 5, isPlaying: false });

  mocks.listeners.get('device_updated')!({ generation: 4, device: laptop({ online: false }) });
  expect(remote.label()).toBe('Laptop is not reachable');

  remote.control.selectTarget(null);
  expect(mocks.watch).toHaveBeenLastCalledWith({ generation: 4, device_id: null });
  expect(remote.label()).toBe('Devices');
  dispose();
  expect(mocks.remove).toHaveBeenCalledTimes(2);
});

it('keeps the chosen device when the service has no socket yet: the service watches it on connect', async () => {
  mocks.listDevices.mockResolvedValue({ devices: [laptop()] });
  mocks.watch.mockRejectedValue(new Error('not connected'));
  const remote = setup(true);
  await remote.control.refreshDevices();
  remote.control.selectTarget('laptop');
  await Promise.resolve();
  expect(remote.control.target()).toBe('laptop');
  expect(remote.control.unreachable()).toBe(false);
  mocks.listeners.get('device_state')!(stateEvent());
  expect(remote.control.held()?.rev).toBe(3);
});

it('opens the shared device sheet for the phone and moves its music to an idle device', async () => {
  mocks.listDevices.mockResolvedValue({ devices: [laptop({ device_id: 'phone', device_name: 'Pixel' }), laptop()] });
  mocks.watch.mockResolvedValue({ device: laptop(), state: null });
  mocks.transfer.mockResolvedValue({ status: 'applied', rev: 4 });
  const remote = setup(true);
  render(() => <OverlayOutlet />);
  openConnectSheet(remote.control, self(song));
  const group = await screen.findByRole('radiogroup');
  await waitFor(() => expect(within(group).getAllByRole('radio')).toHaveLength(2));
  const [phone] = within(group).getAllByRole('radio');
  expect(phone).toHaveTextContent('Pixel');
  expect(phone).toHaveTextContent('Midnight City · M83');
  await fireEvent.click(screen.getByRole('button', { name: 'Move music here' }));
  expect(mocks.transfer).toHaveBeenCalledWith('phone', 'laptop');
  await waitFor(() => expect(remote.control.target()).toBe('laptop'));
  expect(remote.label()).toBe('Playing on Laptop');
});
