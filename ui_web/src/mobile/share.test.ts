import { afterEach, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
const bridge = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge }));
import { nativeShareTrack } from './share';
import { decodeTrackCapsule } from '../lib/trackShare';
afterEach(() => vi.resetAllMocks());
it('uses the shared fragment capsule and keeps origin cookies and stream URLs out of the payload', async () => {
  bridge.open.mockResolvedValue({ opened: true });
  const track = { id: 'dQw4w9WgXcQ', source: 'preview', title: 'Song', artist: 'Artist',
    youtube_id: '9bZkp7q19f0', url: 'https://private.example/api/stream', cookie: 'private-test-cookie' } as Track;
  expect(await nativeShareTrack(track, () => 7, () => true)).toBe(true);
  const payload = bridge.open.mock.calls[0][0];
  expect(payload).toEqual({ generation: 7, title: 'Song', text: 'Song — Artist', url: expect.any(String) });
  const url = new URL(payload.url); expect(url.search).toBe('');
  expect(decodeTrackCapsule(url.hash.slice(3))).toMatchObject({ yt: 'dQw4w9WgXcQ', title: 'Song', artist: 'Artist' });
  expect(JSON.stringify(payload)).not.toMatch(/private-test-cookie|private.example|9bZkp7q19f0/);
});
it('shares podcasts and local music without a video identity as text only', async () => {
  bridge.open.mockResolvedValue({ opened: true });
  for (const track of [{ id: 'local', title: 'Song', artist: 'Artist' }, { id: 'episode', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode', podcast_episode_guid: 'guid' }]) {
    await nativeShareTrack(track as Track, () => 7, () => true);
    expect(bridge.open.mock.lastCall![0]).not.toHaveProperty('url');
  }
});
it('rejects stale invocation and completion and propagates native refusal', async () => {
  const track = { id: 'local', title: 'Song', artist: 'Artist' } as Track;
  expect(await nativeShareTrack(track, () => 7, () => false)).toBe(false); expect(bridge.open).not.toHaveBeenCalled();
  let generation = 7, done!: (value: { opened: boolean }) => void;
  bridge.open.mockReturnValue(new Promise(resolve => done = resolve));
  const result = nativeShareTrack(track, () => generation, () => true); generation = 8; done({ opened: true });
  expect(await result).toBe(false);
  bridge.open.mockRejectedValueOnce(new Error('SHARE_SESSION_CHANGED'));
  await expect(nativeShareTrack(track, () => 8, () => true)).rejects.toThrow('SHARE_SESSION_CHANGED');
});
