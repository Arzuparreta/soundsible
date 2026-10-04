import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, request } from '../lib/http';
import { createNativeFileDeletion } from './fileDeletion';
import type { Track } from '../types/music';

vi.mock('../lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../lib/http')>(), request: vi.fn() }));
const track: Track = { id: 'acquired-hash', title: 'Song', artist: 'Artist', youtube_id: 'B1111111111' };
beforeEach(() => vi.resetAllMocks());
function setup() {
  let owner = 1;
  const retire = vi.fn(async () => {}), copy = vi.fn(async () => {}), refresh = vi.fn(async () => {});
  const deletion = createNativeFileDeletion(() => owner, () => true, () => new AbortController().signal,
    () => [track], retire, copy, refresh);
  return { deletion, retire, copy, refresh, account: (next: number) => { owner = next; } };
}
it('coalesces deletion and leaves the program/copy untouched until a fresh private snapshot proves absence', async () => {
  const state = setup(); let read!: (value: unknown) => void;
  vi.mocked(request).mockResolvedValueOnce({ status: 'success' }).mockImplementationOnce(() => new Promise(resolve => { read = resolve; }));
  const first = state.deletion.remove(track);
  expect(state.deletion.remove(track)).toBe(first);
  await Promise.resolve(); await Promise.resolve();
  expect(state.retire).not.toHaveBeenCalled(); expect(state.copy).not.toHaveBeenCalled();
  read({ tracks: [{ ...track, id: 'B1111111111', source: 'preview' }] });
  expect(await first).toBe(true);
  expect(state.retire).toHaveBeenCalledWith(track.id); expect(state.copy).toHaveBeenCalledWith(track.id);
  expect(state.retire.mock.invocationCallOrder[0]).toBeLessThan(state.copy.mock.invocationCallOrder[0]);
  expect(state.refresh).toHaveBeenCalledOnce(); expect(state.deletion.busy(track.id)).toBe(false);
});
it.each([
  ['permission', new ApiError(403, 'Denied'), undefined],
  ['receipt', { status: 'failed' }, undefined],
  ['still present', { status: 'success' }, { tracks: [track] }],
  ['invalid snapshot', { status: 'success' }, { tracks: null }],
] as const)('rejects %s without claiming local retirement', async (_name, receipt, snapshot) => {
  const state = setup();
  if (receipt instanceof Error) vi.mocked(request).mockRejectedValueOnce(receipt);
  else vi.mocked(request).mockResolvedValueOnce(receipt);
  if (snapshot) vi.mocked(request).mockResolvedValueOnce(snapshot);
  await expect(state.deletion.remove(track)).rejects.toThrow();
  expect(state.retire).not.toHaveBeenCalled(); expect(state.copy).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
});
it('allows recovery after an earlier server delete, but refreshes and reports a local cleanup failure', async () => {
  const state = setup();
  vi.mocked(request).mockRejectedValueOnce(new ApiError(404, 'Missing')).mockResolvedValueOnce({ tracks: [] });
  state.copy.mockRejectedValueOnce(new Error('Cannot remove copy'));
  await expect(state.deletion.remove(track)).rejects.toThrow('Cannot remove copy');
  expect(state.retire).toHaveBeenCalledWith(track.id); expect(state.refresh).toHaveBeenCalledOnce();
});
it('never retires the next account when the previous private snapshot arrives late', async () => {
  const state = setup();
  vi.mocked(request).mockResolvedValueOnce({ status: 'success' }).mockImplementationOnce(async () => { state.account(2); return { tracks: [] }; });
  expect(await state.deletion.remove(track)).toBe(false);
  expect(state.retire).not.toHaveBeenCalled(); expect(state.copy).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
});
it('stops cleanup when native retirement crosses an account change', async () => {
  const state = setup();
  vi.mocked(request).mockResolvedValueOnce({ status: 'success' }).mockResolvedValueOnce({ tracks: [] });
  state.retire.mockImplementationOnce(async () => { state.account(2); });
  expect(await state.deletion.remove(track)).toBe(false);
  expect(state.copy).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled();
});
it('does not report success to an account replaced during the final refresh', async () => {
  const state = setup();
  vi.mocked(request).mockResolvedValueOnce({ status: 'success' }).mockResolvedValueOnce({ tracks: [] });
  state.refresh.mockImplementationOnce(async () => { state.account(2); });
  expect(await state.deletion.remove(track)).toBe(false);
});
it('rejects previews and podcasts without issuing a server write', async () => {
  const state = setup();
  await expect(state.deletion.remove({ ...track, source: 'preview' })).rejects.toThrow('Acquired');
  await expect(state.deletion.remove({ ...track, media_kind: 'podcast_episode' })).rejects.toThrow('Acquired');
  expect(request).not.toHaveBeenCalled();
});
