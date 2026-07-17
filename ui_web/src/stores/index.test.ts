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
    searchYouTube: vi.fn(),
    relatedYouTube: vi.fn(),
    emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
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
    playbackYoutubeId: (track: { id: string; youtube_id?: string | null; source?: 'preview' }) =>
      track.source === 'preview' ? track.id : track.youtube_id || null,
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

  it('playNow inserts into the queue after the current track instead of replacing it', async () => {
    const { actions, state } = await loadStore();
    const t3: Track = { id: 't3', title: 'Three', artist: 'Artist', youtube_id: 'yt333yt333y' };

    actions.playFrom([t1, t2], 0);
    actions.playNow(t3);

    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(state.playback.currentTrack?.id).toBe('t3');

    // Already queued (as its preview twin): jump to it, no duplicate.
    actions.playNow({ id: 'yt333yt333y', title: 'Three', artist: 'Chan', source: 'preview' });
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(state.playback.currentTrack?.id).toBe('t3');

    actions.playNow(t2);
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(state.playback.currentTrack?.id).toBe('t2');
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

describe('Auto Mode store contract', () => {
  it('preserves the manual queue and play state while restoring playback preferences on exit', async () => {
    const related = Array.from({ length: 10 }, (_, i) => ({
      id: `auto-${i}`,
      title: `Auto ${i}`,
      channel: `Artist ${i}`,
    }));
    const { actions, state } = await loadStore({
      relatedYouTube: vi.fn().mockResolvedValue(related),
      searchYouTube: vi.fn().mockResolvedValue([{ id: 'yt-current' }]),
    });
    const paused: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
    const manual: Track = { id: 'manual', title: 'Manual next', artist: 'Listener' };
    actions.playFrom([paused, manual], 0);
    const wasPlaying = state.playback.isPlaying;
    actions.toggleShuffle();
    actions.cycleRepeat();
    actions.cycleRepeat();

    actions.enterAutoMode();
    expect(state.autoMode.active).toBe(true);
    expect(state.playback.isPlaying).toBe(wasPlaying);
    expect(state.playback.shuffle).toBe(false);
    expect(state.playback.repeat).toBe('off');
    expect(state.playback.queue.slice(0, 2).map((track) => track.id)).toEqual(['current', 'manual']);

    await vi.waitFor(() => expect(state.playback.queue.length).toBeGreaterThan(2));
    expect(state.playback.queue.slice(0, 2).map((track) => track.id)).toEqual(['current', 'manual']);

    actions.exitAutoMode();
    expect(state.autoMode.active).toBe(false);
    expect(state.playback.isPlaying).toBe(wasPlaying);
    expect(state.playback.shuffle).toBe(true);
    expect(state.playback.repeat).toBe('one');
    expect(state.playback.queue.length).toBeGreaterThan(2);
  });

  it('does not enter Auto Mode for podcasts', async () => {
    const { actions, state } = await loadStore();
    const podcast: Track = { id: 'episode', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' };
    actions.playFrom([podcast], 0);
    actions.enterAutoMode();
    expect(state.autoMode.active).toBe(false);
  });
});

describe('Radio mode', () => {
  const seed: Track = { id: 'seed1', title: 'Seed Song', artist: 'Artist', youtube_id: 'yt111111111', source: 'preview' as const };

  function mockRelated(otherId: string) {
    return vi.fn().mockResolvedValue([
      { id: otherId, title: 'Other', channel: 'Chan', duration: 200, thumbnail: 'thumb' },
    ]);
  }

  it('startRadio does not reload audio when the seed is already playing (Bug 2)', async () => {
    const { actions, state, audioService, api } = await loadStore({
      searchYouTube: vi.fn(),
      relatedYouTube: mockRelated('mix01'),
      emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
    });

    // Seed is currently playing some way in.
    actions.playFrom([seed], 0);
    audioService.load.mockClear();
    expect(state.playback.isPlaying).toBe(true);

    await actions.startRadio(seed);

    // No audio reload — A keeps playing from currentTime.
    expect(audioService.load).not.toHaveBeenCalled();
    expect(state.playback.radioMode).toBe(true);
    expect(state.playback.radioLoading).toBe(false);
    expect(state.playback.radioSeedId).toBe(seed.id);
    expect(state.playback.queue.map((t) => t.id)).toEqual(['seed1', 'mix01']);
    expect(api.relatedYouTube).toHaveBeenCalledWith('yt111111111', undefined, false);
  });

  it('startRadio swaps audio immediately when the seed is not the current track', async () => {
    const t3: Track = { id: 'other', title: 'B', artist: 'X', youtube_id: 'yt222222222', source: 'preview' as const };
    const seed2: Track = { id: 'seed2', title: 'C', artist: 'Y', youtube_id: 'yt333333333', source: 'preview' as const };
    const { actions, state, audioService } = await loadStore({
      searchYouTube: vi.fn(),
      relatedYouTube: mockRelated('mix02'),
      emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
    });

    actions.playFrom([t3], 0);
    audioService.load.mockClear();

    await actions.startRadio(seed2);

    expect(audioService.load).toHaveBeenCalledTimes(1);
    expect(audioService.load).toHaveBeenCalledWith('/preview/seed2');
    expect(state.playback.radioMode).toBe(true);
    expect(state.playback.radioSeedId).toBe('seed2');
    expect(state.playback.queue.map((t) => t.id)).toEqual(['seed2', 'mix02']);
  });

  it('exits radio mode, keeps current track, on mix generation failure', async () => {
    const { actions, state } = await loadStore({
      searchYouTube: vi.fn(),
      relatedYouTube: vi.fn().mockRejectedValue(new Error('boom')),
      emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
    });

    actions.playFrom([seed], 0);
    await actions.startRadio(seed);

    expect(state.playback.radioMode).toBe(false);
    expect(state.playback.radioLoading).toBe(false);
    expect(state.playback.radioSeedId).toBeNull();
    // Queue truncated to current track (the seed).
    expect(state.playback.queue.map((t) => t.id)).toEqual(['seed1']);
  });

  it('playNow disables radio when a different track is requested', async () => {
    const t3: Track = { id: 't3', title: 'Three', artist: 'Artist', youtube_id: 'yt333333333' };
    const { actions, state } = await loadStore();
    actions.playFrom([seed], 0, { radio: true });
    // Simulate radio active.
    expect(state.playback.radioMode).toBe(true);

    // playNow a different track cancels radio.
    actions.playNow(t3);
    expect(state.playback.radioMode).toBe(false);
  });

  it('next/jumpTo keep radio active (navigating within the radio queue)', async () => {
    const { actions, state } = await loadStore();
    actions.playFrom([seed, { id: 'mixA', title: 'A', artist: 'x', source: 'preview' }, { id: 'mixB', title: 'B', artist: 'y', source: 'preview' }], 0, { radio: true });
    expect(state.playback.radioMode).toBe(true);
    actions.jumpTo(1);
    expect(state.playback.radioMode).toBe(true);
    actions.next();
    expect(state.playback.radioMode).toBe(true);
  });

  it('stopRadio drops the rest of the mix but keeps the current track', async () => {
    const { actions, state } = await loadStore();
    actions.playFrom([seed, { id: 'mixA', title: 'A', artist: 'x', source: 'preview' }], 0, { radio: true });
    expect(state.playback.radioMode).toBe(true);
    actions.stopRadio();
    expect(state.playback.radioMode).toBe(false);
    expect(state.playback.radioLoading).toBe(false);
    expect(state.playback.radioSeedId).toBeNull();
    expect(state.playback.queue.map((t) => t.id)).toEqual(['seed1']);
  });
});
