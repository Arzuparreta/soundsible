import { describe, expect, it, vi } from 'vitest';
import { mergeLibraryPage, readLibraryChanges, validateLibraryPage, type LibraryPage } from './librarySync';

const page = (override: Partial<LibraryPage> = {}): LibraryPage => ({
  epoch: 'account', revision: 3, mode: 'snapshot', tracks: [], removed: [], positions: {}, next_cursor: null, ...override,
});

describe('revision-based library synchronization', () => {
  it('retries conflicting pages without publishing mixed snapshots', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ tracks: [{ id: 'old', title: 'Old', artist: 'A' }], next_cursor: 1 }))
      .mockRejectedValueOnce({ status: 409 })
      .mockResolvedValueOnce(page({ revision: 4, tracks: [{ id: 'new', title: 'New', artist: 'A' }] }));
    const result = await readLibraryChanges(fetchPage, null, new AbortController().signal);
    expect(result.tracks?.map((track) => track.id)).toEqual(['new']);
    expect(result.revision).toBe(4);
  });

  it('aborts a stalled dependency that ignores cancellation', async () => {
    const controller = new AbortController();
    const result = readLibraryChanges(() => new Promise(() => {}), null, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retains track objects for playlist-only changes', () => {
    const tracks = [{ id: 'a', title: 'A', artist: 'Artist' }];
    expect(mergeLibraryPage(tracks, page({ mode: 'delta' }), new Map())).toBe(tracks);
  });

  it('applies rekeys, removals and explicit order without duplicating songs', () => {
    const unchanged = { id: 'b', title: 'B', artist: 'Artist' };
    const tracks = [{ id: 'a', title: 'A', artist: 'Artist' }, unchanged];
    const positions = new Map([['a', 0], ['b', 1]]);
    const merged = mergeLibraryPage(tracks, page({ mode: 'delta', removed: ['a'],
      tracks: [{ id: 'new-a', title: 'A', artist: 'Artist' }], positions: { 'new-a': 0 } }), positions);
    expect(merged.map((track) => track.id)).toEqual(['new-a', 'b']);
    expect(merged[1]).toBe(unchanged);
  });

  it('rejects a malformed server contract before touching state', () => {
    expect(() => validateLibraryPage({ tracks: [{}] })).toThrow('Invalid library page');
  });
});
