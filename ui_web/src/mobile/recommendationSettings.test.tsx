import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeRecommendationSettings } from './recommendationSettings';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup(confirm = vi.fn().mockResolvedValue(true)) {
  let state!: ReturnType<typeof createNativeRecommendationSettings>;
  const [identity, setIdentity] = createSignal(1), [available, setAvailable] = createSignal(true);
  render(() => { state = createNativeRecommendationSettings({ identity, available }, confirm); return null; });
  return { state, setIdentity, setAvailable, confirm };
}
it('confirms both mutation and persisted learning without optimistic changes', async () => {
  mocks.request.mockResolvedValueOnce({ learning_enabled: true }).mockResolvedValueOnce({ learning_enabled: false }).mockResolvedValueOnce({ learning_enabled: false });
  const { state } = setup(); await waitFor(() => expect(state.learning()).toBe(true));
  const operation = state.toggle(); expect(state.learning()).toBe(true); await operation;
  expect(state.learning()).toBe(false); expect(state.error()).toBe('');
  expect(mocks.request.mock.calls[1][1].body).toEqual({ learning_enabled: false });
});
it('contains rejected receipts and retries a failed initial read', async () => {
  mocks.request.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ learning_enabled: true }).mockResolvedValueOnce({ learning_enabled: true });
  const { state } = setup(); await waitFor(() => expect(state.error()).not.toBe(''));
  expect(state.learning()).toBeUndefined(); await state.load(); expect(state.learning()).toBe(true);
  await state.toggle(); expect(state.learning()).toBe(true); expect(state.error()).not.toBe('');
  expect(mocks.request).toHaveBeenCalledTimes(3);
});
it('drops an old account reply and never sends reset after its delayed confirmation changes account', async () => {
  let deliver!: (value: { learning_enabled: boolean }) => void, approve!: (value: boolean) => void;
  mocks.request.mockReturnValueOnce(new Promise(done => deliver = done)).mockResolvedValue({ learning_enabled: false });
  const { state, setIdentity } = setup(vi.fn().mockReturnValue(new Promise(done => approve = done)));
  setIdentity(2); deliver({ learning_enabled: true }); await waitFor(() => expect(state.learning()).toBe(false));
  expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
  const operation = state.reset(); setIdentity(3); approve(true); await operation;
  expect(mocks.request.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
  expect(state.resetDone()).toBe(false);
});
it('requires confirmed reset and respects explicit cancellation and disconnection', async () => {
  mocks.request.mockResolvedValue({ learning_enabled: true });
  const { state, confirm, setAvailable } = setup(); await waitFor(() => expect(state.learning()).toBe(true));
  confirm.mockResolvedValueOnce(false); await state.reset(); expect(mocks.request).toHaveBeenCalledOnce();
  mocks.request.mockResolvedValueOnce({ status: 'reset' }); await state.reset(); expect(state.resetDone()).toBe(true);
  mocks.request.mockResolvedValueOnce({ status: 'ignored' }); await state.reset(); expect(state.resetDone()).toBe(false); expect(state.error()).not.toBe('');
  setAvailable(false); const count = mocks.request.mock.calls.length; await state.toggle(); await state.reset(); expect(mocks.request).toHaveBeenCalledTimes(count);
});
