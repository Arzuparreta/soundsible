import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import NativeDevices from './Devices';
const mocks = vi.hoisted(() => ({ state: vi.fn(), listen: vi.fn(), request: vi.fn() }));
vi.mock('./devices', () => ({ nativeDevices: { deviceState: mocks.state, addListener: mocks.listen } }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const remove = vi.fn().mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue({ remove });
  mocks.state.mockResolvedValue({ generation: 4, device_id: 'native', connected: true });
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
  expect(mocks.request.mock.calls.every(([path]) => path === '/api/devices')).toBe(true);
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
