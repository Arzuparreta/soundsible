import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { NativeLive } from './Live';
const mocked = vi.hoisted(() => ({ state: vi.fn(), command: vi.fn(), listen: vi.fn(), directory: vi.fn() }));
vi.mock('./live', () => ({ nativeLive: { liveState: mocked.state, liveCommand: mocked.command, addListener: mocked.listen, liveDirectory: mocked.directory } }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const session = { id: 'room', title: 'Room', host: { display_name: 'DJ' }, listener_count: 1, whep_url: 'https://media.example/live/whep' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function setup() {
  const remove = vi.fn().mockResolvedValue(undefined);
  let update: ((state: unknown) => void) | undefined;
  mocked.listen.mockImplementation((_event, callback) => { update = callback; return Promise.resolve({ remove }); });
  mocked.state.mockResolvedValue({ generation: 4, ready: true, host: null, listener: null });
  mocked.directory.mockResolvedValue({ config: { state: 'available', api_url: 'https://community.example' }, sessions: [session] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [session] }), { status: 200 })));
  return { remove, update: (state: unknown) => update?.(state) };
}
it('uses the native service for hosting, preserves room on view cleanup and rejects stale events', async () => {
  const controls = setup();
  mocked.command.mockResolvedValue({ generation: 4, ready: true, host: { session, connected: true, messages: [] }, listener: null });
  const view = render(() => <NativeLive generation={() => 4} current={() => true} username="member" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'live.goLive' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'live.goLive' }));
  expect(mocked.command).toHaveBeenCalledWith({ action: 'liveStart', title: 'Session by member', generation: 4 });
  expect(screen.getByRole('button', { name: 'live.end' })).toBeEnabled();
  controls.update({ generation: 3, ready: true, host: null, listener: null });
  expect(screen.getByRole('button', { name: 'live.end' })).toBeInTheDocument();
  view.unmount(); expect(controls.remove).toHaveBeenCalledOnce(); expect(mocked.command).toHaveBeenCalledOnce();
});
it('listens from the configured public directory and sends bounded room commands through native transport', async () => {
  const controls = setup();
  mocked.command.mockResolvedValue({ generation: 4, ready: true, host: null, listener: { session, playing: true, connected: true, volume: .8, messages: [] } });
  render(() => <NativeLive generation={() => 4} current={() => true} username="member" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'live.listen' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'live.listen' }));
  expect(mocked.directory).toHaveBeenCalledWith({ generation: 4 });
  expect(fetch).not.toHaveBeenCalled();
  expect(mocked.command).toHaveBeenCalledWith({ action: 'liveListen', generation: 4, session: { ...session, api_url: 'https://community.example', guest_name: 'member' } });
  await fireEvent.click(screen.getByRole('button', { name: 'common.pause' }));
  expect(mocked.command).toHaveBeenLastCalledWith({ action: 'livePause', generation: 4 });
  await waitFor(() => expect(screen.getByRole('button', { name: 'live.leave' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'live.leave' }));
  expect(mocked.command).toHaveBeenLastCalledWith({ action: 'liveLeave', generation: 4 });
  controls.update({ generation: 4, ready: true, host: null, listener: null });
});
it('does not dispatch actions after account ownership changes', async () => {
  setup(); const [current, setCurrent] = createSignal(true);
  render(() => <NativeLive generation={() => 4} current={current} username="member" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'live.goLive' })).toBeEnabled());
  setCurrent(false);
  await fireEvent.click(screen.getByRole('button', { name: 'live.goLive' }));
  expect(mocked.command).not.toHaveBeenCalled();
});
it('hands observed authentication expiry back to the account owner', async () => {
  setup(); const expired = vi.fn();
  mocked.command.mockRejectedValue({ code: 'AUTH_EXPIRED' });
  render(() => <NativeLive generation={() => 4} current={() => true} username="member" onAuthExpired={expired} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'live.goLive' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'live.goLive' }));
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
});
