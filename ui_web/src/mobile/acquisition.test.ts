import { beforeEach, expect, it, vi } from 'vitest';
import { createMusicAcquisition } from './acquisition';
import { request } from '../lib/http';
import type { Track } from '../types/music';
vi.mock('../lib/http', () => ({ request: vi.fn() }));
const track: Track = { id: 'B1111111111', title: 'Song', artist: 'Artist', source: 'preview', originKeys: ['deezer:12'] };
beforeEach(() => vi.resetAllMocks());
it('allows acquisition after file deletion even while its completed receipt is visible', async () => {
  vi.mocked(request).mockResolvedValue({ status: 'queued', accepted: [{ index: 0, id: 'replacement' }], rejected: [] });
  const refresh = vi.fn(async () => {});
  const acquisition = createMusicAcquisition(() => 1, () => true, () => new AbortController().signal, () => [],
    () => [{ id: 'completed', status: 'completed', video_id: track.id }], refresh);
  expect(acquisition.busy(track.id)).toBe(false);
  await acquisition.add(track);
  expect(request).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});
it('coalesces acquisition intent and carries exact song aliases without creating playback', async () => {
  let reply!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(() => new Promise(resolve => { reply = resolve; }));
  const refresh = vi.fn(async () => {});
  const acquisition = createMusicAcquisition(() => 1, () => true, () => new AbortController().signal, () => [], () => [], refresh);
  const first = acquisition.add(track);
  expect(acquisition.add(track)).toBe(first);
  expect(acquisition.busy(track.id)).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('/api/downloader/queue', expect.objectContaining({ body: { items: [expect.objectContaining({ video_id: track.id, identity_keys: ['yt:B1111111111', 'deezer:12'] })] } }));
  reply({ status: 'queued', accepted: [{ index: 0, id: 'job' }], rejected: [] });
  await first; expect(refresh).toHaveBeenCalledOnce(); expect(acquisition.busy(track.id)).toBe(false);
});
it('requires durable acceptance and never refreshes a replacement account', async () => {
  const refresh = vi.fn(async () => {}); let owner = 1;
  const acquisition = createMusicAcquisition(() => owner, () => true, () => new AbortController().signal, () => [], () => [], refresh);
  vi.mocked(request).mockResolvedValue({ status: 'queued', accepted: [], rejected: [] });
  await expect(acquisition.add(track)).rejects.toThrow('confirmation'); expect(refresh).not.toHaveBeenCalled();
  vi.mocked(request).mockImplementation(async () => { owner = 2; return { status: 'queued', accepted: [{ index: 0, id: 'old-job' }], rejected: [] }; });
  await acquisition.add(track); expect(refresh).not.toHaveBeenCalled();
});
it('does not enqueue acquired songs, active jobs or podcast previews', async () => {
  const acquired = createMusicAcquisition(() => 1, () => true, () => new AbortController().signal, () => [{ id: 'hash', title: 'Song', artist: 'Artist', youtube_id: track.id }], () => [], vi.fn());
  await acquired.add(track);
  const active = createMusicAcquisition(() => 1, () => true, () => new AbortController().signal, () => [], () => [{ id: 'job', status: 'downloading', video_id: track.id }], vi.fn());
  await active.add(track);
  await expect(active.add({ ...track, media_kind: 'podcast_episode' })).rejects.toThrow('Unsupported');
  expect(request).not.toHaveBeenCalled();
});
