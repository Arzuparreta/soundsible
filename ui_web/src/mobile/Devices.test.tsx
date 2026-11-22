import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import NativeDevices from './Devices';
const mocks = vi.hoisted(() => ({ state: vi.fn(), listen: vi.fn(), rename: vi.fn(), request: vi.fn(), prompt: vi.fn() }));
vi.mock('./devices', () => ({ nativeDevices: { deviceState: mocks.state, deviceRename: mocks.rename, addListener: mocks.listen } }));
vi.mock('../lib/prompt', () => ({ promptDialog: mocks.prompt }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/i18n', () => ({ t: (key: string, params?: Record<string, string>) => params ? `${key}:${Object.values(params).join(',')}` : key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const remove = vi.fn().mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue({ remove });
  mocks.state.mockResolvedValue({ generation: 4, device_id: 'native', connected: true, device_name: 'Pixel 8' });
  return remove;
}
it('keeps this phone’s name and pairing, and no longer controls other devices from Settings', async () => {
  const remove = setup();
  const view = render(() => <NativeDevices generation={() => 4} current={() => true} />);
  await waitFor(() => expect(screen.getByText('Pixel 8')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'deviceSheet.ariaPlay' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'deviceSheet.transfer' })).not.toBeInTheDocument();
  // The device sheet lists devices; Settings asks the engine for none.
  expect(mocks.request.mock.calls.some(([path]) => String(path).startsWith('/api/devices'))).toBe(false);
  view.unmount(); expect(remove).toHaveBeenCalledOnce();
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
