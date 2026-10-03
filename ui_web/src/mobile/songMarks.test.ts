import { expect, it, vi } from 'vitest';
import { songMarkAction } from './songMarks';
import type { Track, SavedEntry } from '../types/music';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const track = { id: 'song', title: 'Song', artist: 'Artist' } as Track;
it('sets captured intent explicitly even when another client updates the mark', async () => {
  let entries: SavedEntry[] = []; const refresh = vi.fn().mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({ is_favourite: true });
  const action = songMarkAction(track, () => entries, () => 1, () => false, refresh, vi.fn());
  entries = [{ keys: ['lib:song'], favourite: true }]; action.onSelect();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(mocks.request).toHaveBeenCalledWith('/api/library/favourites', expect.objectContaining({ method: 'PUT', body: { entry: { keys: ['lib:song'], title: 'Song', artist: 'Artist' }, marked: true } }));
});
it('rejects a menu selected after account change', () => {
  mocks.request.mockClear(); let generation = 1;
  const action = songMarkAction(track, () => [], () => generation, () => false, vi.fn(), vi.fn());
  generation = 2; action.onSelect(); expect(mocks.request).not.toHaveBeenCalled();
});
