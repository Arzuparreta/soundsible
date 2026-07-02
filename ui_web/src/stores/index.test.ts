import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const t1: Track = { id: 't1', title: 'One', artist: 'Artist', duration: 180 };
const t2: Track = { id: 't2', title: 'Two', artist: 'Artist', duration: 200 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function loadStore(apiOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('device_id', 'dev1');

  const api = {
    getLibrary: vi.fn().mockResolvedValue({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] }),
    getFavourites: vi.fn().mockResolvedValue([]),
    getPlaybackState: vi.fn().mockResolvedValue(undefined),
    putPlaybackState: vi.fn().mockResolvedValue({ status: 'ok' }),
    deleteTrack: vi.fn().mockResolvedValue({ status: 'ok' }),
    ...apiOverrides,
  };
  const audioService = {
    load: vi.fn().mockResolvedValue(undefined),
    prime: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    getVolume: vi.fn(() => 1),
  };

  vi.doMock('../lib/api', () => ({ api }));
  vi.doMock('../lib/audio', () => ({ audioEl: vi.fn(), audioService }));
  vi.doMock('../lib/media', () => ({
    streamUrl: (id: string) => `/stream/${id}`,
    previewUrl: (id: string) => `/preview/${id}`,
    podcastStreamUrl: (id: string) => `/podcast/${id}`,
    coverUrl: (id: string) => `/cover/${id}`,
    bustCovers: vi.fn(),
  }));
  vi.doMock('../lib/toast', () => ({
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(() => ({ update: vi.fn() })),
    },
  }));
  vi.doMock('../lib/haptics', () => ({ vibrate: vi.fn() }));
  vi.doMock('../lib/socket', () => ({ createSocket: vi.fn() }));

  const store = await import('./index');
  return { ...store, api, audioService };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Solid store library and playback resume', () => {
  it('auto-restores same-device playback paused instead of showing the cross-device banner', async () => {
    const { actions, state, resumeState, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({ tracks: [t1], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getPlaybackState: vi.fn().mockResolvedValue({
        device_id: 'dev1',
        device_name: 'Soundsible Web',
        track_id: 't1',
        track: t1,
        position_sec: 37,
        is_playing: false,
        updated_at: Date.now() / 1000,
      }),
    });

    await actions.syncLibrary();
    await actions.checkResume();

    expect(resumeState()).toBeNull();
    expect(state.playback.currentTrack?.id).toBe('t1');
    expect(state.playback.isPlaying).toBe(false);
    expect(state.playback.currentTime).toBe(37);
    expect(audioService.prime).toHaveBeenCalledWith('/stream/t1', 37);
  });

  it('keeps other-device playback as an explicit resume banner', async () => {
    const { actions, state, resumeState } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({ tracks: [t1], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getPlaybackState: vi.fn().mockResolvedValue({
        device_id: 'dev2',
        device_name: 'Phone',
        track_id: 't1',
        track: t1,
        position_sec: 12,
        is_playing: true,
        updated_at: Date.now() / 1000,
      }),
    });

    await actions.syncLibrary();
    await actions.checkResume();

    expect(state.playback.currentTrack).toBeNull();
    expect(resumeState()?.track_id).toBe('t1');
  });

  it('removes a deleted track from library-derived and playback state immediately', async () => {
    const { actions, state, audioService, api } = await loadStore({
      getLibrary: vi
        .fn()
        .mockResolvedValueOnce({ tracks: [t1, t2], playlists: { Mix: ['t1', 't2'] }, settings: {}, podcast_subscriptions: [] })
        .mockResolvedValueOnce({ tracks: [t2], playlists: { Mix: ['t2'] }, settings: {}, podcast_subscriptions: [] }),
      getFavourites: vi.fn().mockResolvedValueOnce(['t1']).mockResolvedValueOnce([]),
    });

    await actions.syncLibrary();
    actions.playFrom([t1, t2], 0);
    await actions.deleteTrack('t1');

    expect(state.library.map((t) => t.id)).toEqual(['t2']);
    expect(state.favorites).toEqual([]);
    expect(state.playlists).toEqual({ Mix: ['t2'] });
    expect(state.playback.currentTrack).toBeNull();
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t2']);
    expect(audioService.pause).toHaveBeenCalled();
    expect(api.putPlaybackState).toHaveBeenCalledWith(expect.objectContaining({ track_id: null }), expect.anything());
  });

  it('does not let an older library sync reinsert a track after optimistic delete', async () => {
    const stale = deferred<{ tracks: Track[]; playlists: Record<string, string[]>; settings: Record<string, never>; podcast_subscriptions: never[] }>();
    const getLibrary = vi
      .fn()
      .mockResolvedValueOnce({ tracks: [t1, t2], playlists: {}, settings: {}, podcast_subscriptions: [] })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ tracks: [t2], playlists: {}, settings: {}, podcast_subscriptions: [] });
    const { actions, state } = await loadStore({ getLibrary });

    await actions.syncLibrary();
    const staleSync = actions.syncLibrary();
    await Promise.resolve();
    await actions.deleteTrack('t1');
    expect(state.library.map((t) => t.id)).toEqual(['t2']);

    stale.resolve({ tracks: [t1, t2], playlists: {}, settings: {}, podcast_subscriptions: [] });
    await staleSync;
    await flush();

    expect(getLibrary).toHaveBeenCalledTimes(3);
    expect(state.library.map((t) => t.id)).toEqual(['t2']);
  });
});
