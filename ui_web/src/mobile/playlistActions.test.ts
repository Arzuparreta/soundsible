import { expect, it, vi } from 'vitest';
import { nativePlaylistActions, nativePlaylistOccurrenceActions } from './playlistActions';
const mocks = vi.hoisted(() => ({ request: vi.fn(), prompt: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/prompt', () => ({ promptDialog: mocks.prompt }));
vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn() }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
it('removes the captured duplicate occurrence and supplies the original sequence', async () => {
  const state = { tracks: [], playlists: { Mix: ['a', 'b', 'a'] } };
  const refresh = vi.fn().mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ playlists: { Mix: ['a', 'b'] } });
  nativePlaylistOccurrenceActions('Mix', 2, () => state, () => true, refresh, vi.fn())[2].onSelect();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(mocks.request).toHaveBeenLastCalledWith('/api/library/playlist-edits/Mix', expect.objectContaining({ body: { expected_track_ids: ['a', 'b', 'a'], track_ids: ['a', 'b'] } }));
});
it('preserves all names when moving a playlist and checks the confirmed order', async () => {
  const state = { tracks: [], playlists: { A: [], B: [] } };const refresh = vi.fn().mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ settings: { playlist_order: ['B', 'A'] } });
  nativePlaylistActions('B', () => state, () => true, refresh, vi.fn())[3].onSelect();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(mocks.request).toHaveBeenLastCalledWith('/api/library/playlist-edits', expect.objectContaining({ body: { expected_order: ['A', 'B'], order: ['B', 'A'] } }));
});
it('a rename prompt cannot submit into a replacement account', async () => {
  mocks.request.mockClear();let current = true;let resolve!: (name: string) => void;
  mocks.prompt.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  nativePlaylistActions('Mix', () => ({ tracks: [], playlists: { Mix: ['a'] } }), () => current, vi.fn(), vi.fn())[0].onSelect();
  current = false;resolve('Renamed');await Promise.resolve();await Promise.resolve();
  expect(mocks.request).not.toHaveBeenCalled();
});
