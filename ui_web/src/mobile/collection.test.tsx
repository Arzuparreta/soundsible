import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNativeCollection } from './collection';
import type { MigrationJob, MigrationTrack } from '../lib/migrationApi';
import type { NativeEntitySubject } from './entityProfile';
const mocks = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn(), songs: vi.fn(), save: vi.fn(), control: vi.fn(), decide: vi.fn() }));
vi.mock('../lib/api', async () => ({ ApiError: (await import('../lib/http')).ApiError, api: {
  getAlbumDownload: mocks.get, getArtistDownload: mocks.get, startAlbumDownload: mocks.start,
  startArtistDownload: mocks.start, getArtistDiscography: mocks.songs, setSavedEntries: mocks.save,
} }));
vi.mock('../lib/migrationApi', () => ({ migrationApi: { control: mocks.control, decide: mocks.decide } }));
const song = { id: '7', title: 'Song', artist: 'Artist', source: 'deezer', type: 'track', duration: 120 } as const;
const subject: NativeEntitySubject = { kind: 'album', name: 'Album', deezerId: '1', view: 'discover' };
const row: MigrationTrack = { source_key: '7', source: null, state: 'needs_review', confidence: 0, candidates: [] };
const job = (changes: Partial<MigrationJob> = {}): MigrationJob => ({ id: 'job-1', provider: 'album:1', source_name: 'Album', state: 'paused',
  manifest: { track_count: 1, library_count: 1, favourite_count: 0, playlists: [], warnings: [] }, selection: {}, playlist_names: {}, counts: {},
  selected_counts: { completed: 0, existing: 0 }, selected_track_count: 1, estimated_download_bytes: 0, tracks: [row], ...changes });
function setup(selected = subject, confirm = vi.fn().mockResolvedValue(true)) {
  const [generation, changeAccount] = createSignal(1), refresh = vi.fn().mockResolvedValue(undefined);
  let state!: ReturnType<typeof createNativeCollection>;
  render(() => { state = createNativeCollection({ subject: () => selected, generation, disconnected: () => false,
    songs: () => [song], owned: () => false, refresh }, confirm); return null; });
  return { state, changeAccount, refresh, confirm };
}
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue({ job: null }); mocks.songs.mockResolvedValue({ tracklist: [song] }); });
afterEach(cleanup);
it('rejects a start receipt from another provider without publishing acquired songs', async () => {
  mocks.start.mockResolvedValue({ job: job({ provider: 'album:2' }) });
  const { state, refresh } = setup(); await state.download();
  expect(state.job()).toBeNull(); expect(state.error()).not.toBe(''); expect(refresh).not.toHaveBeenCalled();
});
it('asks before downloading a full artist discography and honours cancellation', async () => {
  const { state, confirm } = setup({ ...subject, kind: 'artist' }, vi.fn().mockResolvedValue(false));
  await state.download(); expect(mocks.songs).toHaveBeenCalledWith('1', expect.any(AbortSignal));
  expect(confirm).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled(); expect(state.busy()).toBe(false);
});
it('aborts a confirmation across accounts before any bulk save request', async () => {
  let answer!: (value: boolean) => void;
  const { state, changeAccount, confirm, refresh } = setup(subject, vi.fn().mockReturnValue(new Promise(done => answer = done)));
  const pending = state.saveSongs(); await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  changeAccount(2); answer(true); await pending;
  expect(mocks.save).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(state.busy()).toBe(false);
});
it('keeps a confirmed mutation when an older status request arrives late', async () => {
  let deliver!: (value: { job: MigrationJob }) => void;
  mocks.get.mockReturnValueOnce(new Promise(done => deliver = done)); mocks.start.mockResolvedValue({ job: job() });
  const { state } = setup(); await state.download(); deliver({ job: job({ id: 'old-job' }) });
  await Promise.resolve(); expect(state.job()?.id).toBe('job-1');
});
it('retains the confirmed decision when resume returns a different job', async () => {
  mocks.get.mockResolvedValue({ job: job() });
  mocks.decide.mockResolvedValue({ job: job({ tracks: [{ ...row, state: 'skipped' }] }) });
  mocks.control.mockResolvedValue({ job: job({ id: 'foreign-job', state: 'running' }) });
  const { state } = setup(); await waitFor(() => expect(state.job()?.id).toBe('job-1'));
  await state.decide(row); expect(state.job()?.tracks?.[0].state).toBe('skipped'); expect(state.job()?.id).toBe('job-1');
  expect(mocks.control).toHaveBeenCalledWith('job-1', 'resume', { signal: expect.any(AbortSignal) });
});
it('clears a transient status error after a successful retry', async () => {
  mocks.get.mockRejectedValueOnce(new Error('Temporary')).mockResolvedValue({ job: job() });
  const { state } = setup(); await waitFor(() => expect(state.error()).not.toBe(''));
  await state.retry(); expect(state.job()?.id).toBe('job-1'); expect(state.error()).toBe('');
});
