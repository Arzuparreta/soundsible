import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeCatalogActions } from './catalogActions';
import type { CatalogItem, Track } from '../types/music';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), save: vi.fn() }));
vi.mock('../lib/api', async () => ({ ApiError: (await import('../lib/http')).ApiError, api: { resolveCatalogItem: mocks.resolve, setSavedEntries: mocks.save } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const item = (id: string): CatalogItem => ({ id, title: id, artist: 'Artist', source: 'library', type: 'library_track', track_id: id });
const tracks: Track[] = [{ id: 'first', title: 'First', artist: 'Artist' }, { id: 'second', title: 'Second', artist: 'Artist' }];
it('plays a collection through the native callback with occurrences and selection intact', async () => {
  const play = vi.fn().mockResolvedValue(undefined), single = vi.fn();
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation: () => 1, disconnected: () => false, saved: () => [], tracks: () => tracks,
    onPlay: single, onPlayCollection: play, onChanged: vi.fn() }); return null; });
  await actions.playCollection([item('first'), item('second'), item('first')], 2);
  expect(play).toHaveBeenCalledWith([tracks[0], tracks[1], tracks[0]], 2);
  expect(single).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it('does not publish an old collection after the account changes during resolution', async () => {
  let deliver!: (value: { video_id: string }) => void;
  mocks.resolve.mockReturnValue(new Promise(done => deliver = done));
  const [generation, setGeneration] = createSignal(1), play = vi.fn();
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation, disconnected: () => false, saved: () => [], tracks: () => [],
    onPlay: vi.fn(), onPlayCollection: play, onChanged: vi.fn() }); return null; });
  const operation = actions.playCollection([{ ...item('remote'), source: 'deezer', type: 'track', track_id: undefined }], 0);
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
  setGeneration(2); actions.reset(true); deliver({ video_id: 'A1111111111' }); await operation;
  expect(mocks.resolve.mock.calls[0][1].aborted).toBe(true); expect(play).not.toHaveBeenCalled();
  expect(actions.pending()).toBeNull(); expect(actions.error()).toBe('');
});
it('promotes a resolved catalog preview to its confirmed acquired source without resolving again', async () => {
  mocks.resolve.mockResolvedValue({ video_id: 'A1111111111' });
  const [library, setLibrary] = createSignal<Track[]>([]), play = vi.fn().mockResolvedValue(undefined);
  const recording: CatalogItem = { id: 'deezer:track:7', source: 'deezer', type: 'track', title: 'Song', artist: 'Artist', external_ids: { deezer_id: '7' } };
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation: () => 1, disconnected: () => false, saved: () => [], tracks: library,
    onPlay: play, onChanged: vi.fn() }); return null; });
  await actions.act(recording, 'play'); expect(actions.trackFor(recording)?.source).toBe('preview');
  const acquired: Track = { id: 'owned-hash', title: 'Song', artist: 'Artist', youtube_id: 'A1111111111' };
  setLibrary([acquired]); expect(actions.trackFor(recording)).toBe(acquired);
  await actions.act(recording, 'play'); expect(play).toHaveBeenLastCalledWith(acquired); expect(mocks.resolve).toHaveBeenCalledOnce();
});
it('finds an acquired recording through confirmed saved identities without a prior preview resolution', () => {
  const recording: CatalogItem = { id: 'deezer:track:8', source: 'deezer', type: 'track', title: 'Same title', artist: 'Artist', external_ids: { deezer_id: '8' } };
  const wrong: Track = { id: 'other', title: 'Same title', artist: 'Artist', youtube_id: 'B1111111111' };
  const acquired: Track = { id: 'downloaded', title: 'Same title', artist: 'Artist', youtube_id: 'A1111111111' };
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation: () => 1, disconnected: () => false,
    saved: () => [{ title: 'Same title', artist: 'Artist', keys: ['deezer:8', 'lib:downloaded', 'yt:A1111111111'] }], tracks: () => [wrong, acquired],
    onPlay: vi.fn(), onChanged: vi.fn() }); return null; });
  expect(actions.trackFor(recording)).toBe(acquired); expect(mocks.resolve).not.toHaveBeenCalled();
  expect(actions.trackFor({ ...recording, id: 'deezer:track:9', external_ids: { deezer_id: '9' } })).toBeNull();
});
it('uses the acquired source for an exact YouTube catalog row', () => {
  const acquired: Track = { id: 'downloaded', title: 'Song', artist: 'Artist', youtube_id: 'A1111111111' };
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation: () => 1, disconnected: () => false,
    saved: () => [], tracks: () => [acquired], onPlay: vi.fn(), onChanged: vi.fn() }); return null; });
  expect(actions.trackFor({ id: 'youtube:track:A1111111111', source: 'youtube', type: 'track', title: 'Song', artist: 'Artist', raw: { id: 'A1111111111' } })).toBe(acquired);
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it('uses only confirmed collection identities, retains them across navigation and drops removed or foreign-account sources', async () => {
  const recording: CatalogItem = { id: 'deezer:track:8', source: 'deezer', type: 'track', title: 'Same title', artist: 'Artist', external_ids: { deezer_id: '8' } };
  const acquired: Track = { id: 'downloaded', title: 'Same title', artist: 'Artist' };
  const [library, setLibrary] = createSignal<Track[]>([acquired]), [generation, setGeneration] = createSignal(1);
  const play = vi.fn().mockResolvedValue(undefined);
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation, disconnected: () => false, saved: () => [], tracks: library,
    onPlay: play, onChanged: vi.fn() }); return null; });
  const receipt = { id: 'confirmed-job', provider: 'album:1', tracks: [{ source_key: '8', source: { identity_keys: ['deezer:8'] }, state: 'completed', matched_track_id: 'downloaded' }] } as unknown as import('../lib/migrationApi').MigrationJob;
  expect(actions.trackFor(recording)).toBeNull();
  actions.adoptCollection({ ...receipt, tracks: receipt.tracks!.map(row => ({ ...row, state: 'downloading' })) }, 1);
  expect(actions.trackFor(recording)).toBeNull();
  actions.adoptCollection(receipt, 1); expect(actions.trackFor(recording)).toBe(acquired);
  expect(actions.trackFor({ ...recording, id: 'deezer:track:9', external_ids: { deezer_id: '9' } })).toBeNull();
  actions.reset(); await actions.act(recording, 'play'); expect(play).toHaveBeenLastCalledWith(acquired);
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  setLibrary([]); expect(actions.trackFor(recording)).toBeNull();
  setLibrary([acquired]); expect(actions.trackFor(recording)).toBe(acquired);
  setGeneration(2); actions.reset(true); actions.adoptCollection(receipt, 1); expect(actions.trackFor(recording)).toBeNull();
});

it('resolves only the selected recording and preserves deferred duplicate occurrences', async () => {
  mocks.resolve.mockResolvedValue({ video_id: 'A1111111111' });
  const play = vi.fn().mockResolvedValue(undefined);
  let actions!: ReturnType<typeof createNativeCatalogActions>;
  render(() => { actions = createNativeCatalogActions({ generation: () => 1, disconnected: () => false, saved: () => [], tracks: () => [],
    onPlay: vi.fn(), onPlayCollection: play, onChanged: vi.fn() }); return null; });
  const remote = (id: string): CatalogItem => ({ id, source: 'deezer', type: 'track', title: id, artist: 'Artist' });
  await actions.playCollection([remote('future'), remote('selected'), remote('future')], 1);
  expect(mocks.resolve).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'future', pendingResolve: { catalogItemId: 'future', title: 'future', artist: 'Artist', duration: undefined } }),
    expect.objectContaining({ id: 'A1111111111', source: 'preview' }),
    expect.objectContaining({ id: 'future', pendingResolve: { catalogItemId: 'future', title: 'future', artist: 'Artist', duration: undefined } }),
  ], 1);
});
