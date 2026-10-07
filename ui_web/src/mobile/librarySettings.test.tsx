import { cleanup, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeLibraryMaintenance } from './librarySettings';
const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: { update: vi.fn(), dismiss: vi.fn() } }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/toast', () => ({ toast: { loading: () => mocks.toast, error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup(dialogs = { confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn().mockResolvedValue('3') }) {
  let state!: ReturnType<typeof createNativeLibraryMaintenance>;
  const [identity, setIdentity] = createSignal(1), [available, setAvailable] = createSignal(true);
  const sync = vi.fn().mockResolvedValue(undefined);
  render(() => { state = createNativeLibraryMaintenance({ identity, available, signal: new AbortController().signal, trackCount: () => 3, sync }, dialogs, 0); return null; });
  return { state, sync, dialogs, setIdentity, setAvailable };
}
const calls = () => mocks.request.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${String(path).replace(/\?t=\d+$/, '')}`);
it('polls a rescan to completion, then syncs and reports the real counts', async () => {
  mocks.request.mockResolvedValueOnce({ state: 'queued' }).mockResolvedValueOnce({ state: 'scanning' })
    .mockResolvedValueOnce({ state: 'completed', added: 2, updated: 1, failed: 0 });
  const { state, sync } = setup(); await state.rescan();
  expect(calls()).toEqual(['POST /api/library/scan', 'GET /api/library/scan', 'GET /api/library/scan']);
  expect(sync).toHaveBeenCalledOnce(); expect(mocks.toast.update).toHaveBeenCalledWith('success', expect.stringContaining('2'));
});
it('treats a failed scan as an error without syncing', async () => {
  mocks.request.mockResolvedValueOnce({ state: 'failed', error: 'disk' });
  const { state, sync } = setup(); await state.rescan();
  expect(sync).not.toHaveBeenCalled(); expect(mocks.toast.update).toHaveBeenCalledWith('error', expect.any(String));
});
it('repairs only after the dry run is accepted and the user confirms', async () => {
  mocks.request.mockResolvedValueOnce({ status: 'started', dry_run: true }).mockResolvedValueOnce({ status: 'started', dry_run: false });
  const declined = setup({ confirm: vi.fn().mockResolvedValue(false), prompt: vi.fn() });
  await declined.state.repair(); expect(calls()).toEqual(['POST /api/library/repair']);
  expect(mocks.request.mock.calls[0][1].body).toEqual({ dry_run: true });
  cleanup(); mocks.request.mockReset();
  mocks.request.mockResolvedValueOnce({ status: 'started', dry_run: true }).mockResolvedValueOnce({ status: 'started', dry_run: false });
  const { state } = setup(); await state.repair();
  expect(mocks.request.mock.calls.map(([, options]) => options.body)).toEqual([{ dry_run: true }, { dry_run: false }]);
});
it('empties the library only after both confirmations with the exact count', async () => {
  mocks.request.mockResolvedValue({ status: 'success' });
  const wrong = setup({ confirm: vi.fn().mockResolvedValue(true), prompt: vi.fn().mockResolvedValue('2') });
  await wrong.state.wipe(); expect(mocks.request).not.toHaveBeenCalled();
  cleanup();
  const { state, sync, dialogs } = setup(); await state.wipe();
  expect(dialogs.prompt.mock.calls[0][0].match).toBe('3');
  expect(calls()).toEqual(['POST /api/library/wipe']); expect(mocks.request.mock.calls[0][1].body).toEqual({ confirm: 'CONFIRM' }); expect(sync).toHaveBeenCalledOnce();
});
it('never purges after the account changes behind a pending confirmation, and aborts its requests', async () => {
  let approve!: (value: boolean) => void;
  const { state, setIdentity } = setup({ confirm: vi.fn().mockReturnValue(new Promise(done => approve = done)), prompt: vi.fn() });
  const operation = state.purge(); setIdentity(2); approve(true); await operation;
  expect(mocks.request).not.toHaveBeenCalled(); expect(state.busy()).toBe(false);
});
it('stops polling and stays silent when the connection drops mid-scan', async () => {
  let deliver!: (value: unknown) => void;
  mocks.request.mockResolvedValueOnce({ state: 'scanning' }).mockReturnValueOnce(new Promise(done => deliver = done));
  const { state, sync, setAvailable } = setup(); const operation = state.rescan();
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  setAvailable(false); deliver({ state: 'completed', added: 1, updated: 0, failed: 0 }); await operation;
  expect(sync).not.toHaveBeenCalled(); expect(mocks.toast.update).not.toHaveBeenCalled(); expect(mocks.toast.dismiss).toHaveBeenCalled();
});
