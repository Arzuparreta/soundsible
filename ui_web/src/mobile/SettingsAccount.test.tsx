import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import NativeSettingsAccount from './SettingsAccount';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import { setLocale } from '../lib/i18n';
import type { User } from '../lib/session';
const mocks = vi.hoisted(() => ({ prompt: vi.fn(), password: vi.fn(), confirm: vi.fn(), request: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../lib/prompt', () => ({ promptDialog: mocks.prompt }));
vi.mock('../lib/passwordDialog', () => ({ passwordDialog: mocks.password }));
vi.mock('../lib/confirm', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
const me: User = { id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true };
beforeEach(() => { cleanup(); setLocale('en'); localStorage.clear(); vi.resetAllMocks(); });
function setup(identity = () => 1, available = () => true) {
  const changed = vi.fn(async () => {}), logout = vi.fn(async () => {}), parent = new AbortController();
  const history = createSearchHistoryStorage(key => `native-member:${key}`);
  const view = render(() => <NativeSettingsAccount user={me} identity={identity} available={available} signal={parent.signal} history={history} onUser={changed} onLogout={logout} />);
  return { view, changed, logout, parent, history };
}
it('cancelled profile intent performs no request', async () => {
  mocks.prompt.mockResolvedValue(null);
  const { view } = setup(); fireEvent.click(view.getByRole('button', { name: /Change name/ }));
  await waitFor(() => expect(mocks.prompt).toHaveBeenCalledOnce());
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
});
it('publishes a confirmed own profile and announces success after its refresh', async () => {
  mocks.prompt.mockResolvedValue('Updated'); const next = { ...me, display_name: 'Updated' };
  mocks.request.mockResolvedValue({ user: next });
  const { view, changed } = setup(); fireEvent.click(view.getByRole('button', { name: /Change name/ }));
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith(next));
  expect(mocks.success).toHaveBeenCalledOnce();
});
it('rejects a failed password change without altering account or announcing success', async () => {
  mocks.prompt.mockResolvedValue('fixture-current'); mocks.password.mockResolvedValue('fixture-new'); mocks.request.mockRejectedValue(new Error('rejected'));
  const { view, changed } = setup(); fireEvent.click(view.getByRole('button', { name: /Change password/ }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  expect(changed).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
});
it.each(['account', 'unmount'])('invalidates a pending prompt after %s changes', async phase => {
  let resolve!: (value: string) => void, epoch = 1;
  mocks.prompt.mockReturnValue(new Promise(done => { resolve = done; }));
  const { view } = setup(() => epoch); fireEvent.click(view.getByRole('button', { name: /Change username/ }));
  if (phase === 'account') epoch++; else view.unmount();
  resolve('replacement'); await Promise.resolve(); await Promise.resolve();
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
});
it('allows local history and confirmed logout while server writes are unavailable', async () => {
  mocks.confirm.mockResolvedValue(true);
  const { view, history, logout } = setup(() => 1, () => false);
  expect(view.getByRole('button', { name: /Change name/ }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(view.getByRole('switch')); expect(history.enabled()).toBe(false);
  fireEvent.click(view.getByRole('button', { name: /Sign out/ }));
  await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  expect(mocks.request).not.toHaveBeenCalled();
});
it('aborts an in-flight profile request on disposal and ignores a provider that still returns', async () => {
  mocks.prompt.mockResolvedValue('Updated');
  let resolve!: (value: unknown) => void;
  mocks.request.mockReturnValue(new Promise(done => { resolve = done; }));
  const { view, changed } = setup();
  fireEvent.click(view.getByRole('button', { name: /Change name/ }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
  const signal = mocks.request.mock.calls[0][1].signal as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true);
  resolve({ user: { ...me, display_name: 'Updated' } });
  await Promise.resolve(); await Promise.resolve();
  expect(changed).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledOnce();
});
it('waits for parent revalidation before offering logout, then confirms the actual action', async () => {
  const [busy, setBusy] = createSignal(true), logout = vi.fn(async () => {});
  mocks.confirm.mockResolvedValue(true);
  const history = createSearchHistoryStorage(key => `busy-member:${key}`);
  const view = render(() => <NativeSettingsAccount busy={busy()} user={me} identity={() => 1} available={() => true}
    signal={new AbortController().signal} history={history} onUser={vi.fn()} onLogout={logout} />);
  const button = view.getByRole('button', { name: /Sign out/ });
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button); expect(mocks.confirm).not.toHaveBeenCalled();
  setBusy(false); expect(button.hasAttribute('disabled')).toBe(false);
  fireEvent.click(button); await waitFor(() => expect(logout).toHaveBeenCalledOnce());
});
