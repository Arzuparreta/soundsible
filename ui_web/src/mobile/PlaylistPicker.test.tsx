import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { openNativePlaylistPicker } from './PlaylistPicker';
import type { Track } from '../types/music';
const mocks = vi.hoisted(() => ({ request: vi.fn(), overlay: vi.fn(), close: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/overlay', () => ({ openOverlay: mocks.overlay }));
vi.mock('../lib/prompt', () => ({ promptDialog: vi.fn() }));
const track = { id: 'song', title: 'Song', artist: 'Artist' } as Track;
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
function picker(current = () => true, song = track) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  openNativePlaylistPicker(song, () => ({ Mix: [] }), current, refresh);
  const view = render(() => mocks.overlay.mock.calls[0][0](mocks.close));
  return { view, refresh };
}
it('closes only after confirmed membership and refresh', async () => {
  mocks.request.mockResolvedValue({ playlists: { Mix: ['song'] } });
  const { view, refresh } = picker();fireEvent.click(view.getByText('Mix'));
  await waitFor(() => expect(mocks.close).toHaveBeenCalled());expect(refresh).toHaveBeenCalledTimes(1);
});
it('keeps failed membership open for a retry', async () => {
  mocks.request.mockResolvedValue({ playlists: { Mix: [] } });
  const { view, refresh } = picker();fireEvent.click(view.getByText('Mix'));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());expect(refresh).not.toHaveBeenCalled();expect(mocks.close).not.toHaveBeenCalled();
});
it('closes and aborts an in-flight request on account change', async () => {
  mocks.request.mockReturnValue(new Promise(() => {}));const [current, change] = createSignal(true);
  const { view } = picker(current);fireEvent.click(view.getByText('Mix'));change(false);
  await waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
});
it('saves preview identity explicitly before adding it without acquisition', async () => {
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.endsWith('/tracks') ? { playlists: { Mix: ['abcdefghijk'] } } : {}));
  const { view } = picker(() => true, { ...track, id: 'abcdefghijk', source: 'preview' });fireEvent.click(view.getByText('Mix'));
  await waitFor(() => expect(mocks.close).toHaveBeenCalled());
  expect(mocks.request.mock.calls.map(([path]) => path)).toEqual(['/api/library/saved/set', '/api/library/playlists/Mix/tracks']);
});
