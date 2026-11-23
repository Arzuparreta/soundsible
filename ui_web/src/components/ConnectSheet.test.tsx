import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Device } from '../lib/api';
import { WEB_REMOTE_COMMANDS } from '../lib/deviceIdentity';
import { discardOverlays, OverlayOutlet } from '../lib/overlay';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import type { AppSocket } from '../lib/socket';
import { resetAccountState, setState, state } from '../stores/core';
import { attachRemoteSocket, refreshDevices, remoteControl, remoteTarget, resetRemoteState, selectTarget } from '../stores/remote';
import { webConnectSelf } from './webConnect';
import { openConnectSheet } from './ConnectSheet';

const mocks = vi.hoisted(() => ({ listDevices: vi.fn(), transfer: vi.fn() }));
vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, listDevices: mocks.listDevices, transfer: mocks.transfer } };
});

const song = { id: 't1', title: 'Midnight City', artist: 'M83', duration: 240 };
const playing = { track: song, is_playing: true, position_sec: 4, measured_at_ms: 0, mode: 'dj' as const, rev: 2 };
const device = (over: Partial<Device>): Device => ({
  device_id: 'mac', device_name: 'MacBook', device_type: 'web', form_factor: 'computer',
  online: true, protocol: 1, commands: [...WEB_REMOTE_COMMANDS], playing: null, ...over,
});

function open(devices: Device[]) {
  mocks.listDevices.mockResolvedValue({ devices });
  render(() => <OverlayOutlet />);
  openConnectSheet(remoteControl, webConnectSelf);
  return screen.findByRole('radiogroup');
}

beforeEach(async () => {
  localStorage.clear();
  discardOverlays();
  resetAccountState();
  resetRemoteState();
  mocks.listDevices.mockReset();
  mocks.transfer.mockReset();
  const lifetime = new RuntimeLifetime();
  lifetime.start();
  attachRemoteSocket({ connected: false, on: vi.fn(), emit: vi.fn() } as unknown as AppSocket, lifetime);
  // The startup check (stores/remote) has run before anyone opens the sheet.
  mocks.listDevices.mockResolvedValue({ devices: [] });
  await refreshDevices();
});

it('lists this device first, then online devices with their song, and controls the one tapped', async () => {
  const group = await open([
    device({ playing }),
    device({ device_id: 'tv', device_name: 'TV', online: false }),
  ]);
  await waitFor(() => expect(within(group).getAllByRole('radio')).toHaveLength(2));
  const [self, mac] = within(group).getAllByRole('radio');
  expect(self).toHaveTextContent(state.device.device_name);
  expect(self).toHaveAttribute('aria-checked', 'true');
  expect(mac).toHaveTextContent('MacBook');
  expect(mac).toHaveTextContent('Midnight City · M83');
  expect(mac).toHaveTextContent('DJ');
  expect(mac).toHaveTextContent('Playing');
  expect(group).not.toHaveTextContent('TV');
  // This device has nothing, the Mac has music: the music can come here.
  expect(screen.getByRole('button', { name: 'Listen here' })).toBeInTheDocument();
  await fireEvent.click(mac);
  expect(remoteTarget()).toBe('mac');
});

it('offers one transfer only when its direction is clear', async () => {
  setState('playback', { currentTrack: song, isPlaying: true });
  const group = await open([device({}), device({ device_id: 'tv', device_name: 'TV', playing })]);
  await waitFor(() => expect(within(group).getAllByRole('radio')).toHaveLength(3));
  expect(screen.getAllByRole('button', { name: 'Move music here' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Listen here' })).toBeNull();

  mocks.transfer.mockResolvedValue({ status: 'applied', rev: 1 });
  await fireEvent.click(screen.getByRole('button', { name: 'Move music here' }));
  expect(mocks.transfer).toHaveBeenCalledWith(state.device.device_id, 'mac');
  await waitFor(() => expect(remoteTarget()).toBe('mac'));
});

it('lists a device that needs an update without letting it be chosen', async () => {
  const group = await open([device({ protocol: null })]);
  const outdated = await within(group).findByText('Update Soundsible on this device to control it');
  expect(outdated.closest('[role="radio"]')).toHaveAttribute('aria-disabled', 'true');
});

it('explains where other devices come from when there are none', async () => {
  await open([]);
  expect(await screen.findByText(/Other devices appear here/)).toBeInTheDocument();
});

it('offers to try again or to use this device when the controlled one is not reachable', async () => {
  mocks.listDevices.mockResolvedValue({ devices: [device({})] });
  selectTarget('mac');
  await open([device({ online: false })]);
  expect(await screen.findByRole('alert')).toHaveTextContent('MacBook is not reachable');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Use this device' }));
  expect(remoteTarget()).toBeNull();
});
