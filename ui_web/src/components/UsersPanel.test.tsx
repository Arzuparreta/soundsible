import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { UsersPanel } from './UsersPanel';
import { setLocale } from '../lib/i18n';
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), remove: vi.fn(), update: vi.fn(), password: vi.fn(), invite: vi.fn(), confirm: vi.fn(), copy: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../lib/session', () => ({ user: () => null, users: { list: mocks.list, create: mocks.create, remove: mocks.remove, update: mocks.update, setPassword: mocks.password }, invites: { create: mocks.invite } }));
vi.mock('../lib/confirm', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../lib/clipboard', () => ({ copyText: mocks.copy }));
vi.mock('../lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn() } }));
const admin = { id: 'owner', username: 'owner', display_name: 'Owner', role: 'admin' as const, has_password: true };
const member = { id: 'member', username: 'member', display_name: 'Member', role: 'member' as const, has_password: true };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('uses the explicit native administrator and never requests people for a member', async () => {
  setLocale('en'); mocks.list.mockResolvedValue({ users: [admin, member] });
  const view = render(() => <UsersPanel account={() => admin} />);
  await waitFor(() => expect(view.getByText('@member')).toBeInTheDocument());
  expect(mocks.list).toHaveBeenCalledOnce(); view.unmount(); mocks.list.mockClear();
  render(() => <UsersPanel account={() => member} />); expect(mocks.list).not.toHaveBeenCalled();
});
it('does not delete after confirmation outlives its account owner', async () => {
  setLocale('en'); mocks.list.mockResolvedValue({ users: [admin, member] });
  let current = true, confirm!: (value: boolean) => void;
  mocks.confirm.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
  const view = render(() => <UsersPanel account={() => admin} current={() => current} />);
  await waitFor(() => expect(view.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
  fireEvent.click(view.getByRole('button', { name: 'Delete' })); current = false; confirm(true); await Promise.resolve();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('does not expose or copy a late invitation after the account changes', async () => {
  setLocale('en'); mocks.list.mockResolvedValue({ users: [admin, member] });
  let current = true, complete!: () => void;
  mocks.invite.mockReturnValue(new Promise(resolve => { complete = () => resolve({ url: 'https://private.invalid/player/#/invite/old-token' }); }));
  const view = render(() => <UsersPanel account={() => admin} current={() => current} />);
  fireEvent.click(view.getByRole('button', { name: 'Create invite link' })); current = false; complete(); await Promise.resolve();
  expect(mocks.copy).not.toHaveBeenCalled(); expect(view.container.querySelector('input[readonly]')).toBeNull();
});
