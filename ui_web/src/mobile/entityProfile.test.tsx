import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeEntityProfile, nativeEntitySubject, nativeProfileBookmark, type NativeEntitySubject } from './entityProfile';
import type { AlbumProfile } from '../types/music';
afterEach(cleanup);
const subject: NativeEntitySubject = { kind: 'album', name: 'Same title', artist: 'Various Artists', view: 'discover', deezerId: '1' };
const profile = (id: string): AlbumProfile => ({ title: 'Same title', artist: 'Various Artists', cover: '', tracklist: [], deezer_id: id, in_library: false, resolved: true, cached: false });
it('keeps exact local/provider ids and the artist credit when opening an entity route', () => {
  const read = nativeEntitySubject('/album/Same%20title?artist=Various+Artists&view=library&album_id=local-1&deezer_id=1');
  expect(read).toEqual({ ...subject, view: 'library', localId: 'local-1' });
  expect(nativeProfileBookmark(read!, profile('2')).destination).toContain('deezer_id=1');
  expect(nativeProfileBookmark({ ...subject, deezerId: undefined }, profile('2')).destination).toContain('deezer_id=2');
  expect(nativeEntitySubject('/search')).toBeNull();
  expect(nativeEntitySubject('https://example.org/artist/Someone')).toBeNull();
});
it('discards a delayed profile from another edition and aborts when offline', async () => {
  let deliver!: (value: AlbumProfile) => void;
  const old = new Promise<AlbumProfile>(done => deliver = done);
  const fetchProfile = vi.fn().mockReturnValueOnce(old).mockResolvedValue(profile('2'));
  const [selected, setSelected] = createSignal(subject), [disconnected, setDisconnected] = createSignal(false);
  let state!: ReturnType<typeof createNativeEntityProfile>;
  render(() => { state = createNativeEntityProfile({ subject: selected, generation: () => 1, disconnected }, fetchProfile); return null; });
  setSelected({ ...subject, deezerId: '2' });
  await waitFor(() => expect(state.profile()?.deezer_id).toBe('2'));
  expect(fetchProfile.mock.calls[0][1].aborted).toBe(true);
  deliver(profile('1')); await Promise.resolve(); expect(state.profile()?.deezer_id).toBe('2');
  setDisconnected(true); expect(fetchProfile.mock.calls.at(-1)![1].aborted).toBe(true);
  expect(state.loading()).toBe(false);
});
it('offers retry after provider failure and clears old account data before the next response', async () => {
  const fetchProfile = vi.fn().mockRejectedValueOnce(new Error('Provider failed')).mockResolvedValueOnce(profile('1')).mockReturnValue(new Promise(() => {}));
  const [generation, setGeneration] = createSignal(1);
  let state!: ReturnType<typeof createNativeEntityProfile>;
  render(() => { state = createNativeEntityProfile({ subject: () => subject, generation, disconnected: () => false }, fetchProfile); return null; });
  await waitFor(() => expect(state.error()).toBe(true)); state.retry();
  await waitFor(() => expect(state.profile()?.deezer_id).toBe('1'));
  setGeneration(2); expect(state.profile()).toBeNull(); expect(state.loading()).toBe(true);
});
