import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createStore } from 'solid-js/store';
import type { LibrarySnapshot } from '../lib/api';
import type { Track } from '../types/music';

const mocks = vi.hoisted(() => ({
  getLibrary: vi.fn(), getSaved: vi.fn(), syncCatalog: vi.fn(),
  invalidateCatalogSync: vi.fn(), registerArtworkMetadata: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: mocks }));
vi.mock('../lib/media', () => ({ registerArtworkMetadata: mocks.registerArtworkMetadata }));
vi.mock('./catalog', () => mocks);
vi.mock('./core', () => {
  const [state, setState] = createStore({
    library: [] as Track[], playlists: {}, librarySettings: {}, podcastSubscriptions: [],
    saved: [], loading: false, libraryReady: false, libraryError: false,
  });
  return { state, setState };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const snapshot = (revision: string): LibrarySnapshot => ({
  tracks: [{ id: revision, title: revision, artist: 'Artist' }], revision,
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.getSaved.mockResolvedValue([]);
  mocks.syncCatalog.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

it('retains library identities and artwork/catalog on 304 while refreshing saved entries', async () => {
  const { syncLibrary } = await import('./library');
  const { state } = await import('./core');
  mocks.getLibrary.mockResolvedValueOnce(snapshot('a')).mockResolvedValueOnce(null);
  await syncLibrary();
  const tracks = state.library;
  const first = tracks[0];
  const playlists = state.playlists;
  mocks.getSaved.mockResolvedValueOnce([{ id: 'saved' }]);
  await syncLibrary();
  expect(mocks.getLibrary.mock.calls).toEqual([[undefined], ['a']]);
  expect(state.library).toBe(tracks);
  expect(state.library[0]).toBe(first);
  expect(state.playlists).toBe(playlists);
  expect(state.saved).toEqual([{ id: 'saved' }]);
  expect(mocks.registerArtworkMetadata).toHaveBeenCalledTimes(1);
  expect(mocks.syncCatalog).toHaveBeenCalledTimes(1);
  expect(state.libraryReady).toBe(true);
  expect(state.libraryError).toBe(false);
});

it('shares a promise through the coalesced follow-up and applies changed and empty snapshots', async () => {
  const { syncLibrary } = await import('./library');
  const { state } = await import('./core');
  const first = deferred<LibrarySnapshot>();
  const second = deferred<LibrarySnapshot>();
  mocks.getLibrary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const running = syncLibrary();
  await Promise.resolve();
  expect(syncLibrary()).toBe(running);
  expect(syncLibrary()).toBe(running);
  const settled = vi.fn();
  void running.then(settled);
  first.resolve(snapshot('a'));
  await vi.waitFor(() => expect(mocks.getLibrary).toHaveBeenCalledTimes(2));
  expect(settled).not.toHaveBeenCalled();
  second.resolve({ tracks: [], revision: 'empty' });
  await running;
  expect(state.library).toEqual([]);
  expect(mocks.getLibrary.mock.calls).toEqual([[undefined], ['a']]);
});

it('abandons stale account responses before artwork or validators can be installed', async () => {
  const { syncLibrary, invalidateLibrarySync } = await import('./library');
  const { state } = await import('./core');
  const old = deferred<LibrarySnapshot>();
  mocks.getLibrary.mockResolvedValueOnce(snapshot('initial')).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot('new'));
  await syncLibrary();
  const oldRun = syncLibrary();
  await Promise.resolve();
  invalidateLibrarySync();
  await syncLibrary();
  old.resolve(snapshot('old'));
  await oldRun;
  expect(state.library[0].id).toBe('new');
  expect(mocks.registerArtworkMetadata).toHaveBeenCalledTimes(2);
  expect(mocks.registerArtworkMetadata).toHaveBeenLastCalledWith(snapshot('new').tracks);
  mocks.getLibrary.mockResolvedValueOnce(null);
  await syncLibrary();
  expect(mocks.getLibrary.mock.calls).toEqual([[undefined], ['initial'], [undefined], ['new']]);
});

it('cancels an invalidated refresh before its first microtask and clears a scheduled refresh', async () => {
  vi.useFakeTimers();
  const { syncLibrary, syncLibrarySoon, invalidateLibrarySync } = await import('./library');
  mocks.getLibrary.mockResolvedValue(snapshot('new'));
  const oldRun = syncLibrary();
  syncLibrarySoon();
  invalidateLibrarySync();
  await oldRun;
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.getLibrary).not.toHaveBeenCalled();
  await syncLibrary();
  expect(mocks.getLibrary).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('preserves a validator across network failure and retries failed catalog projection on 304', async () => {
  const { syncLibrary } = await import('./library');
  const { state } = await import('./core');
  mocks.syncCatalog.mockResolvedValueOnce(false).mockResolvedValue(true);
  mocks.getLibrary.mockResolvedValueOnce(snapshot('a')).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
  await syncLibrary();
  await syncLibrary();
  expect(state.libraryError).toBe(true);
  expect(state.library[0].id).toBe('a');
  await syncLibrary();
  expect(state.libraryError).toBe(false);
  expect(mocks.getLibrary.mock.calls).toEqual([[undefined], ['a'], ['a']]);
  expect(mocks.syncCatalog).toHaveBeenCalledTimes(2);
});

it('keeps full refreshes compatible with engines that do not send a revision', async () => {
  const { syncLibrary } = await import('./library');
  mocks.getLibrary.mockResolvedValue({ tracks: [] });
  await syncLibrary();
  await syncLibrary();
  expect(mocks.getLibrary.mock.calls).toEqual([[undefined], [undefined]]);
  expect(mocks.syncCatalog).toHaveBeenCalledTimes(2);
});
