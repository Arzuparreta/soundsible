import { beforeEach, expect, it, vi } from 'vitest';
import { createNativeAccountMutations } from './accountMutations';
import { request } from '../lib/http';
import type { User } from '../lib/session';
vi.mock('../lib/http', () => ({ request: vi.fn() }));
const me: User = { id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true };
beforeEach(() => vi.resetAllMocks());
it('requires the own-profile receipt and a fresh authoritative name snapshot', async () => {
  const next = { ...me, display_name: 'Updated' }, changed = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValueOnce({ user: next }).mockResolvedValueOnce({ user: next });
  const mutations = createNativeAccountMutations(() => 1, () => me, () => true, () => new AbortController().signal, changed);
  expect(await mutations.profile({ display_name: 'Updated' })).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith(next);
  expect(request).toHaveBeenLastCalledWith('/api/auth/state', expect.objectContaining({ cache: 'no-store' }));
});
it('does not publish a profile whose server snapshot has not confirmed the requested name', async () => {
  const changed = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValue({ user: me });
  const mutations = createNativeAccountMutations(() => 1, () => me, () => true, () => new AbortController().signal, changed);
  await expect(mutations.profile({ username: 'new-name' })).rejects.toThrow('snapshot');
  expect(changed).not.toHaveBeenCalled();
});
it('never publishes a foreign receipt', async () => {
  const changed = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValue({ user: { ...me, id: 'owner' } });
  const mutations = createNativeAccountMutations(() => 1, () => me, () => true, () => new AbortController().signal, changed);
  await expect(mutations.profile({ display_name: 'New' })).rejects.toThrow('confirmation');
  expect(request).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
});
it.each(['receipt', 'snapshot', 'refresh'])('invalidates an obsolete account during %s', async phase => {
  let epoch = 1;
  const changed = vi.fn(async () => { if (phase === 'refresh') epoch++; });
  vi.mocked(request).mockImplementation(async path => {
    if ((phase === 'receipt' && path === '/api/auth/profile') || (phase === 'snapshot' && path === '/api/auth/state')) epoch++;
    return { user: me };
  });
  const mutations = createNativeAccountMutations(() => epoch, () => me, () => true, () => new AbortController().signal, changed);
  expect(await mutations.profile({ display_name: me.display_name })).toBe(false);
  expect(changed).toHaveBeenCalledTimes(phase === 'refresh' ? 1 : 0);
});
it('publishes a password change only after its own account and password state are confirmed', async () => {
  const changed = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValueOnce({ status: 'ok', user: me }).mockResolvedValueOnce({ user: me });
  const mutations = createNativeAccountMutations(() => 1, () => me, () => true, () => new AbortController().signal, changed);
  expect(await mutations.password('fixture-current', 'fixture-new')).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith(me);
});
