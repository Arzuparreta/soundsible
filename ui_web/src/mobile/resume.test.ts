import { createRoot, createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/i18n', () => ({ t: (key: string, params?: Record<string, string>) => params ? `${key}:${Object.values(params).join(',')}` : key }));
import { createNativeResume } from './resume';
const NOW = 1_800_000_000_000;
const remote = (fields: Record<string, unknown> = {}) => ({ device_id: 'laptop', device_name: 'Laptop', track_id: 't1', track: { id: 't1', title: 'Song' }, updated_at: NOW / 1000 - 60, ...fields });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { localStorage.clear(); mocks.request.mockReset(); });
afterEach(() => vi.restoreAllMocks());
function setup(initialSelf: string | null = 'phone') {
  const [identity, setIdentity] = createSignal(1), [idle, setIdle] = createSignal(true), [self, setSelf] = createSignal<string | null>(initialSelf);
  let resume!: ReturnType<typeof createNativeResume>, dispose!: () => void;
  createRoot(root => { dispose = root; resume = createNativeResume({ identity, available: () => true, idle, self }, () => NOW); });
  return { resume, setIdentity, setIdle, setSelf, dispose };
}
it('offers a recent session from another device once per account, excluding this phone', async () => {
  mocks.request.mockResolvedValue(remote());
  const { resume, setIdle } = setup(); await flush();
  expect(mocks.request).toHaveBeenCalledWith('/api/playback/state?exclude_device=phone', expect.anything());
  expect(resume.offer()?.device_id).toBe('laptop');
  setIdle(false); expect(resume.offer()).toBeNull();
  setIdle(true); await flush(); expect(mocks.request).toHaveBeenCalledTimes(1);
});
it('ignores stale, empty and own sessions', async () => {
  for (const value of [remote({ updated_at: NOW / 1000 - 25 * 3600 }), remote({ track_id: null }), remote({ device_id: 'phone' }), undefined]) {
    mocks.request.mockResolvedValueOnce(value);
    const { resume, dispose } = setup(); await flush(); expect(resume.offer()).toBeNull(); dispose();
  }
});
it('transfers the session to this phone through Core and honours a recent "No"', async () => {
  mocks.request.mockResolvedValueOnce(remote()).mockResolvedValueOnce({ status: 'applied', rev: 4 });
  const first = setup(); await flush();
  const err = await first.resume.resume();
  expect(err).toBeNull();
  expect(mocks.request.mock.calls[1]).toEqual(['/api/devices/transfer', expect.objectContaining({ method: 'POST', body: { from_device_id: 'laptop', to_device_id: 'phone' } })]);
  expect(first.resume.offer()).toBeNull(); first.dispose();
  mocks.request.mockResolvedValueOnce(remote());
  const second = setup(); await flush(); second.resume.dismiss(); second.dispose();
  mocks.request.mockResolvedValueOnce(remote());
  const third = setup(); await flush(); expect(third.resume.offer()).toBeNull(); third.dispose();
  mocks.request.mockResolvedValueOnce(remote({ updated_at: NOW / 1000 + 10 }));
  const fourth = setup(); await flush(); expect(fourth.resume.offer()?.device_id).toBe('laptop');
});
it('keeps the offer and returns the contract error message when transfer is rejected', async () => {
  mocks.request.mockResolvedValueOnce(remote())
    .mockRejectedValueOnce({ status: 409, payload: { status: 'rejected', reason: 'nothing_playing', step: 'export' } });
  const { resume, dispose } = setup(); await flush();
  const err = await resume.resume();
  expect(err).toBe('deviceSheet.nothingPlaying:Laptop');
  expect(resume.offer()?.device_id).toBe('laptop');
  dispose();
});
it('waits for this phone to be registered and drops an answer for a previous account', async () => {
  let deliver!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(new Promise(done => deliver = done)).mockResolvedValue(undefined);
  const { resume, setSelf, setIdentity } = setup(null); await flush();
  expect(mocks.request).not.toHaveBeenCalled();
  setSelf('phone'); await flush(); expect(mocks.request).toHaveBeenCalledTimes(1);
  setIdentity(2); deliver(remote()); await flush();
  expect(resume.offer()).toBeNull();
});
it('keeps asking while this phone\'s registration state ticks', async () => {
  let deliver!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(new Promise(done => deliver = done));
  const { resume, setSelf } = setup(); await flush();
  setSelf(null); setSelf('phone'); deliver(remote()); await flush();
  expect(resume.offer()?.device_id).toBe('laptop'); expect(mocks.request).toHaveBeenCalledTimes(1);
});
