import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeSubsonicAccess } from './subsonicAccess';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const status = (configured = false, created_at: string | null = null) => ({ username: 'member', configured, created_at, last_used_at: null, last_client: null });
function setup(confirm = vi.fn().mockResolvedValue(true), copy = vi.fn().mockResolvedValue(true)) {
  let state!: ReturnType<typeof createNativeSubsonicAccess>;
  const [accountId, setAccountId] = createSignal('first'), [available, setAvailable] = createSignal(true);
  render(() => { state = createNativeSubsonicAccess({ identity: () => 1, accountId, username: () => 'member', origin: () => 'https://fixture.example', available }, confirm, copy); return null; });
  return { state, setAccountId, setAvailable, confirm, copy };
}
it('keeps only the confirmed one-time password and clears it on account change even with the same username', async () => {
  mocks.request.mockResolvedValueOnce({ ...status(), password: 'unexpected-get-secret' }).mockResolvedValueOnce({ ...status(true, 'new'), password: 'fixture-secret' }).mockResolvedValueOnce(status(true, 'new')).mockResolvedValue(status());
  const { state, setAccountId, confirm } = setup(); await waitFor(() => expect(state.access()).not.toBeNull());
  expect(state.password()).toBe(''); await state.generate(); expect(state.password()).toBe('fixture-secret'); expect(confirm).not.toHaveBeenCalled();
  expect(Object.hasOwn(state.access()!, 'password')).toBe(false);
  setAccountId('second'); expect(state.password()).toBe(''); await waitFor(() => expect(state.access()?.configured).toBe(false));
});
it('requires a new status read after an unconfirmed credential mutation', async () => {
  mocks.request.mockResolvedValueOnce(status()).mockResolvedValueOnce(status(true, 'new')).mockResolvedValueOnce(status(true, 'new'));
  const { state, confirm } = setup(); await waitFor(() => expect(state.access()).not.toBeNull());
  await state.generate(); expect(state.access()).toBeNull(); expect(state.password()).toBe(''); expect(state.error()).not.toBe('');
  await state.load(); expect(state.access()?.configured).toBe(true);
  confirm.mockResolvedValueOnce(false); await state.generate(); expect(mocks.request).toHaveBeenCalledTimes(3);
});
it('discards an old credential response and aborts its request when identity changes', async () => {
  let deliver!: (value: unknown) => void;
  mocks.request.mockResolvedValueOnce(status()).mockReturnValueOnce(new Promise(done => deliver = done)).mockResolvedValue(status());
  const { state, setAccountId } = setup(); await waitFor(() => expect(state.access()).not.toBeNull());
  const operation = state.generate(); await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  const signal = mocks.request.mock.calls[1][1].signal; setAccountId('second'); deliver({ ...status(true, 'new'), password: 'old-fixture-secret' }); await operation;
  expect(signal.aborted).toBe(true); expect(state.password()).toBe(''); expect(state.access()?.configured).toBe(false);
});
it('never sends a revoke or replacement after a delayed confirmation loses its account', async () => {
  let approve!: (value: boolean) => void; mocks.request.mockResolvedValue(status(true, 'old'));
  const { state, setAvailable } = setup(vi.fn().mockReturnValue(new Promise(done => approve = done)));
  await waitFor(() => expect(state.access()).not.toBeNull()); const operation = state.revoke(); setAvailable(false); approve(true); await operation;
  expect(mocks.request).toHaveBeenCalledOnce(); expect(state.access()).toBeNull(); expect(state.password()).toBe('');
});
it('copies the actual engine origin and does not publish an old-account copy completion', async () => {
  let finish!: (value: boolean) => void; mocks.request.mockResolvedValue(status());
  const copy = vi.fn().mockReturnValue(new Promise(done => finish = done));
  const { state, setAccountId } = setup(undefined, copy); await waitFor(() => expect(state.access()).not.toBeNull());
  const operation = state.copyServer(); expect(copy).toHaveBeenCalledWith('https://fixture.example', false); setAccountId('second'); finish(true); await operation;
  expect(state.copied()).toBe(false);
});
it('requires consistent confirmed status before exposing a generated password', async () => {
  mocks.request.mockResolvedValueOnce(status()).mockResolvedValueOnce({ ...status(true, 'new'), password: 'fixture-secret' }).mockResolvedValueOnce(status(true, 'changed'));
  const { state } = setup(); await waitFor(() => expect(state.access()).not.toBeNull()); await state.generate();
  expect(state.access()).toBeNull(); expect(state.password()).toBe(''); expect(state.error()).not.toBe('');
});
it('confirms revocation and contains clipboard failures without retaining secret in the public status', async () => {
  mocks.request.mockResolvedValueOnce(status()).mockResolvedValueOnce({ ...status(true, 'new'), password: 'fixture-secret' }).mockResolvedValueOnce(status(true, 'new')).mockResolvedValueOnce(status()).mockResolvedValueOnce(status());
  const { state, copy } = setup(); await waitFor(() => expect(state.access()).not.toBeNull()); await state.generate();
  copy.mockRejectedValueOnce(new Error('Clipboard unavailable')); await state.copyPassword(); expect(state.copied()).toBe(false); expect(state.error()).not.toBe('');
  await state.revoke(); expect(state.access()?.configured).toBe(false); expect(state.password()).toBe('');
});
