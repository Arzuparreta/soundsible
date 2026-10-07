import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import NativeDevices from './Devices';
const mocks = vi.hoisted(() => ({ state: vi.fn(), listen: vi.fn(), handoff: vi.fn(), rename: vi.fn(), request: vi.fn(), prompt: vi.fn() }));
vi.mock('./devices', () => ({ nativeDevices: { deviceState: mocks.state, deviceHandoff: mocks.handoff, deviceRename: mocks.rename, addListener: mocks.listen } }));
vi.mock('../lib/prompt', () => ({ promptDialog: mocks.prompt }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const remove = vi.fn().mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue({ remove });
  mocks.state.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, can_handoff: true });
  mocks.request.mockResolvedValue({ devices: [
    { device_id: 'native', device_name: 'Android', socket_active: true },
    { device_id: 'peer', device_name: 'Laptop', socket_active: true },
    { device_id: 'offline', device_name: 'Offline', socket_active: false },
  ] });
  return remove;
}
it('identifies service device and only controls other online devices', async () => {
  setup(); render(() => <NativeDevices generation={() => 4} current={() => true} />);
  await waitFor(() => expect(screen.getByText('deviceSheet.selfSuffix')).toBeInTheDocument());
  const play = screen.getAllByRole('button', { name: 'deviceSheet.ariaPlay' });
  expect(play).toHaveLength(2); expect(play[1]).toBeDisabled();
  await fireEvent.click(play[0]);
  expect(mocks.request).toHaveBeenCalledWith('/api/playback/remote-command', expect.objectContaining({ body: { device_id: 'peer', command: 'play' } }));
});
it('disables controls after account change and removes subscription on cleanup', async () => {
  const remove = setup(); const [current, setCurrent] = createSignal(true);
  const view = render(() => <NativeDevices generation={() => 4} current={current} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'deviceSheet.ariaPause' })[0]).toBeEnabled());
  setCurrent(false); await fireEvent.click(screen.getAllByRole('button', { name: 'deviceSheet.ariaPause' })[0]);
  expect(mocks.request.mock.calls.some(([path]) => path === '/api/playback/remote-command')).toBe(false);
  view.unmount(); expect(remove).toHaveBeenCalledOnce();
});
it('ignores a device list which finishes after account ownership changes', async () => {
  setup(); let resolve!: (value: unknown) => void;
  mocks.request.mockImplementation(() => new Promise(done => { resolve = done; }));
  const [generation, setGeneration] = createSignal(4);
  render(() => <NativeDevices generation={generation} current={() => true} />);
  await waitFor(() => expect(mocks.request).toHaveBeenCalled());
  setGeneration(5); resolve({ devices: [{ device_id: 'old', device_name: 'Old account' }] });
  await Promise.resolve(); expect(screen.queryByText('Old account')).not.toBeInTheDocument();
});

it('uses the service to publish and hand off its queue, with account ownership guards', async () => {
  setup(); mocks.handoff.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, can_handoff: true });
  const [current, setCurrent] = createSignal(true);
  render(() => <NativeDevices generation={() => 4} current={current} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'deviceSheet.transfer' })[0]).toBeEnabled());
  await fireEvent.click(screen.getAllByRole('button', { name: 'deviceSheet.transfer' })[0]);
  expect(mocks.handoff).toHaveBeenCalledWith({ generation: 4, device_id: 'peer' });
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'deviceSheet.transfer' })[0]).toBeEnabled());
  setCurrent(false); await fireEvent.click(screen.getAllByRole('button', { name: 'deviceSheet.transfer' })[0]);
  expect(mocks.handoff).toHaveBeenCalledOnce();
});
it('renames this device through the native service and shows the name it confirms', async () => {
  setup(); mocks.state.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, device_name: 'Pixel 8' });
  mocks.prompt.mockResolvedValue('  Kitchen  '); mocks.rename.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, device_name: 'Kitchen' });
  render(() => <NativeDevices generation={() => 4} current={() => true} />);
  await waitFor(() => expect(screen.getByText('Pixel 8')).toBeInTheDocument());
  await fireEvent.click(screen.getByRole('button', { name: /settings.deviceName/ }));
  await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith({ generation: 4, name: 'Kitchen' }));
  await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
});
it('does not rename after the account changes behind the name dialog', async () => {
  setup(); mocks.state.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, device_name: 'Pixel 8' });
  const [current, setCurrent] = createSignal(true); let answer!: (value: string) => void;
  mocks.prompt.mockReturnValue(new Promise(done => answer = done));
  render(() => <NativeDevices generation={() => 4} current={current} />);
  await waitFor(() => expect(screen.getByText('Pixel 8')).toBeInTheDocument());
  await fireEvent.click(screen.getByRole('button', { name: /settings.deviceName/ }));
  setCurrent(false); answer('Other'); await Promise.resolve();
  expect(mocks.rename).not.toHaveBeenCalled();
});
