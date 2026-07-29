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

async function loadStore(
  apiOverrides: Record<string, unknown> = {},
  audioOverrides: Record<string, unknown> = {},
) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('device_id', 'dev1');

  const api = {
    getLibrary: vi.fn().mockResolvedValue({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] }),
    getSaved: vi.fn().mockResolvedValue([]),
    toggleSaved: vi.fn().mockResolvedValue({ is_saved: true }),
    toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
    resolveCatalogItem: vi.fn().mockResolvedValue({ video_id: null }),
    enqueueDownload: vi.fn().mockResolvedValue({ status: 'ok' }),
    getDownloadQueue: vi.fn().mockResolvedValue({ queue: [], is_processing: false }),
    getPlaybackState: vi.fn().mockResolvedValue(undefined),
    putPlaybackState: vi.fn().mockResolvedValue({ status: 'ok' }),
    deleteTrack: vi.fn().mockResolvedValue({ status: 'ok' }),
    searchYouTube: vi.fn(),
    relatedYouTube: vi.fn(),
    emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
    sendPlayTiming: vi.fn().mockResolvedValue({ status: 'ok' }),
    getDiscoverySettings: vi.fn().mockResolvedValue({ learning_enabled: true, autoplay_enabled: true }),
    setAutoplayEnabled: vi.fn().mockResolvedValue({ autoplay_enabled: true }),
    ...apiOverrides,
  };
  const audioService = {
    load: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue(undefined),
    prime: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    getVolume: vi.fn(() => 1),
    ...audioOverrides,
  };

  vi.doMock('../lib/api', () => ({ api }));
  vi.doMock('../lib/audio', () => ({
    audioEl: vi.fn(),
    audioService,
    storedVolume: () => 1,
    isCurrentLoad: () => true,
  }));
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
      loading: vi.fn(() => ({ update: vi.fn(), dismiss: vi.fn() })),
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
      getSaved: vi
        .fn()
        .mockResolvedValueOnce([{ keys: ['lib:t1'], title: 'One', artist: 'Artist', favourite: true }])
        .mockResolvedValueOnce([]),
    });

    await actions.syncLibrary();
    actions.playFrom([t1, t2], 0);
    await actions.deleteTrack('t1');

    expect(state.library.map((t) => t.id)).toEqual(['t2']);
    expect(state.saved).toEqual([]);
    expect(state.playlists).toEqual({ Mix: ['t2'] });
    expect(state.playback.currentTrack).toBeNull();
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t2']);
    // stop(), not pause(): the deleted track's stream must be released, not
    // left buffering a file that no longer exists.
    expect(audioService.stop).toHaveBeenCalled();
    expect(api.putPlaybackState).toHaveBeenCalledWith(expect.objectContaining({ track_id: null }), expect.anything());
  });

  it('playNow inserts into the queue after the current track instead of replacing it', async () => {
    const { actions, state } = await loadStore();
    const t3: Track = { id: 't3', title: 'Three', artist: 'Artist', youtube_id: 'yt333yt333y' };

    actions.playFrom([t1, t2], 0);
    actions.playNow(t3);

    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(state.playback.currentTrack?.id).toBe('t3');

    // Re-requesting the current occurrence is coalesced across source identity.
    actions.playNow({ id: 'yt333yt333y', title: 'Three', artist: 'Chan', source: 'preview' });
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(state.playback.currentTrack?.id).toBe('t3');

    // A future occurrence does not consume the existing context occurrence:
    // explicit requests allow duplicates and remain a separate lane.
    actions.playNow(t2);
    expect(state.playback.queue.map((t) => t.id)).toEqual(['t1', 't3', 't2', 't2']);
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

describe('Playback load coalescing', () => {
  const preview: Track = { id: 'previewid01', title: 'Preview', artist: 'Chan', source: 'preview' };

  it('collapses repeated taps on the entry already loading into one request', async () => {
    const { actions, state, audioService } = await loadStore();

    actions.playTrack(preview);
    expect(state.playback.isLoading).toBe(true);
    expect(audioService.load).toHaveBeenCalledTimes(1);

    // A preview click costs the engine a yt-dlp resolution and a proxied
    // stream; the impatient re-taps must not each buy another one.
    actions.playTrack(preview);
    actions.playTrack(preview);
    actions.playNow(preview);
    expect(audioService.load).toHaveBeenCalledTimes(1);
  });

  it('switching to a different preview mid-load loads exactly the newest one', async () => {
    const { actions, state, audioService } = await loadStore();
    const other: Track = { id: 'previewid02', title: 'Other', artist: 'Chan', source: 'preview' };

    actions.playTrack(preview);
    actions.playTrack(other);

    expect(audioService.load).toHaveBeenCalledTimes(2);
    expect(audioService.load).toHaveBeenLastCalledWith('/preview/previewid02');
    expect(state.playback.currentTrack?.id).toBe('previewid02');
  });

  it('resumes rather than restarting when the active entry is paused', async () => {
    // The auto-restored (paused) track from the last session: tapping it must
    // pick up at the saved position, not throw it away and start over.
    const { actions, state, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({ tracks: [t1], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getPlaybackState: vi.fn().mockResolvedValue({
        device_id: 'dev1',
        track_id: 't1',
        track: t1,
        position_sec: 37,
        is_playing: false,
        updated_at: Date.now() / 1000,
      }),
    });

    await actions.syncLibrary();
    await actions.checkResume();
    expect(state.playback.isPlaying).toBe(false);

    actions.playTrack(t1);
    expect(audioService.load).not.toHaveBeenCalled();
    expect(audioService.resume).toHaveBeenCalledTimes(1);
    expect(state.playback.currentTime).toBe(37);
  });

  it('skips to the next entry when a track cannot be played, then gives up', async () => {
    const { actions, state, audioService } = await loadStore({}, {
      load: vi.fn().mockRejectedValue(new Error('502')),
      recover: vi.fn().mockRejectedValue(new Error('502')),
    });

    actions.playFrom([t1, t2], 0);
    await flush();

    // t1 failed → advanced to t2, which also failed → nothing left to try.
    expect(audioService.load).toHaveBeenCalledTimes(2);
    expect(state.playback.currentTrack?.id).toBe('t2');
    expect(state.playback.loadError).toBe(true);
    expect(state.playback.isPlaying).toBe(false);
  });

  it('reports one failure per attempt, not one per error channel', async () => {
    // A failed load surfaces twice: play() rejects AND the element fires
    // `error`. Counting both would skip two entries for one broken track — and
    // blame the innocent one that just started.
    const load = vi.fn().mockRejectedValueOnce(new Error('502')).mockResolvedValue(undefined);
    const { actions, state, audioService } = await loadStore({}, {
      load,
      recover: vi.fn().mockRejectedValueOnce(new Error('502')),
    });
    const t3: Track = { id: 't3', title: 'Three', artist: 'Artist' };

    actions.playFrom([t1, t2, t3], 0);
    await flush();

    expect(audioService.load).toHaveBeenCalledTimes(2);
    expect(state.playback.currentTrack?.id).toBe('t2');
    expect(state.playback.loadError).toBe(false);
  });

  it('retryCurrent re-requests the failed entry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('502')).mockResolvedValue(undefined);
    const { actions, state, audioService } = await loadStore({}, {
      load,
      recover: vi.fn().mockRejectedValueOnce(new Error('502')),
    });

    actions.playTrack(preview);
    await flush();
    expect(state.playback.loadError).toBe(true);

    actions.retryCurrent();
    expect(audioService.load).toHaveBeenCalledTimes(2);
    expect(state.playback.loadError).toBe(false);
  });
});

describe('Playback queue lanes', () => {
  it('keeps explicit requests ahead of a finite context with FIFO add and LIFO play-next', async () => {
    const { actions, state } = await loadStore();
    const context = [
      { id: 'c0', title: 'Context 0', artist: 'A' },
      { id: 'c1', title: 'Context 1', artist: 'A' },
      { id: 'c2', title: 'Context 2', artist: 'A' },
    ];
    const add1 = { id: 'add-1', title: 'Add 1', artist: 'Me' };
    const add2 = { id: 'add-2', title: 'Add 2', artist: 'Me' };
    const next1 = { id: 'next-1', title: 'Next 1', artist: 'Me' };
    const next2 = { id: 'next-2', title: 'Next 2', artist: 'Me' };

    actions.playFrom(context, 0, {
      context: { id: 'playlist:test', kind: 'playlist', label: 'Test' },
    });
    actions.enqueue(add1);
    actions.enqueue(add2);
    actions.playNext(next1);
    actions.playNext(next2);

    expect(state.playback.queue.map((track) => track.id)).toEqual([
      'c0',
      'next-2',
      'next-1',
      'add-1',
      'add-2',
      'c1',
      'c2',
    ]);
    expect(state.playback.queue.slice(1, 5).every((entry) => entry.queueLane === 'manual')).toBe(true);
    expect(state.playback.queue.slice(5).every((entry) => entry.queueLane === 'context')).toBe(true);
  });

  it('preserves manual occurrences when a new context is chosen and allows duplicates', async () => {
    const { actions, state } = await loadStore();
    const duplicate = { id: 'requested', title: 'Requested', artist: 'Me' };

    actions.playFrom([t1, t2], 0);
    actions.enqueue(duplicate);
    actions.enqueue(duplicate);
    actions.playFrom(
      [
        { id: 'fresh-0', title: 'Fresh 0', artist: 'B' },
        { id: 'fresh-1', title: 'Fresh 1', artist: 'B' },
      ],
      0,
      { context: { id: 'album:fresh', kind: 'album', label: 'Fresh' } },
    );

    expect(state.playback.queue.map((track) => track.id)).toEqual([
      'fresh-0',
      'requested',
      'requested',
      'fresh-1',
    ]);
    expect(state.playback.queue[1].queueId).not.toBe(state.playback.queue[2].queueId);
    actions.clearManualQueue();
    expect(state.playback.queue.map((track) => track.id)).toEqual(['fresh-0', 'fresh-1']);
  });

  it('does not shuffle or repeat manual requests as context', async () => {
    const { actions, state } = await loadStore();
    actions.playFrom(
      [
        { id: 'c0', title: 'Context 0', artist: 'A' },
        { id: 'c1', title: 'Context 1', artist: 'A' },
        { id: 'c2', title: 'Context 2', artist: 'A' },
      ],
      0,
    );
    actions.enqueue({ id: 'manual', title: 'Manual', artist: 'Me' });
    actions.toggleShuffle();
    expect(state.playback.queue[1].id).toBe('manual');

    actions.cycleRepeat();
    while (state.playback.index < state.playback.queue.length - 1) actions.next();
    actions.next();
    expect(state.playback.queue.every((entry) => entry.queueLane === 'context')).toBe(true);
    expect(state.playback.currentTrack?.id).toBe('c0');
  });
});

describe('Global Autoplay', () => {
  it('prepares a small generated tail near the end and keeps manual requests first', async () => {
    const relatedYouTube = vi.fn().mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `auto-${index}`,
        title: `Auto ${index}`,
        channel: 'Related',
      })),
    );
    const { actions, state } = await loadStore({ relatedYouTube });
    const context: Track[] = Array.from({ length: 4 }, (_, index) => ({
      id: `context-${index}`,
      title: `Context ${index}`,
      artist: 'A',
      youtube_id: `yt-context-${index}`,
    }));

    actions.playFrom(context, 0);
    await flush();
    expect(relatedYouTube).not.toHaveBeenCalled();

    actions.next();
    await vi.waitFor(() =>
      expect(state.playback.queue.some((entry) => entry.queueSource === 'autoplay')).toBe(true),
    );
    expect(state.playback.queue.slice(0, 4).map((entry) => entry.id)).toEqual([
      'context-0',
      'context-1',
      'context-2',
      'context-3',
    ]);

    actions.enqueue({ id: 'manual', title: 'Manual', artist: 'Me' });
    expect(state.playback.queue.map((entry) => entry.id)).toEqual([
      'context-0',
      'context-1',
      'manual',
      'context-2',
      'context-3',
    ]);
    expect(state.playback.queue[2].queueLane).toBe('manual');
  });

  it('is account-configurable and never runs for podcasts', async () => {
    const relatedYouTube = vi.fn().mockResolvedValue([
      { id: 'auto-1', title: 'Auto 1', channel: 'Related' },
    ]);
    const { actions, state, api } = await loadStore({ relatedYouTube });
    actions.playFrom([
      { id: 'episode', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' },
    ], 0);
    await flush();
    expect(relatedYouTube).not.toHaveBeenCalled();

    await actions.setAutoplayEnabled(false);
    expect(state.playback.autoplayEnabled).toBe(false);
    expect(api.setAutoplayEnabled).toHaveBeenCalledWith(false);
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
    actions.playFrom([paused], 0);
    actions.enqueue(manual);
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

  it('keeps every explicit request ahead of Auto Mode generation', async () => {
    const related = Array.from({ length: 10 }, (_, i) => ({ id: `auto-${i}`, title: `Auto ${i}`, channel: `Artist ${i}` }));
    const { actions, state } = await loadStore({
      relatedYouTube: vi.fn().mockResolvedValue(related),
      searchYouTube: vi.fn().mockResolvedValue([{ id: 'yt-current' }]),
    });
    const cur: Track = { id: 'current', title: 'Cur', artist: 'A', youtube_id: 'yt-current' };
    const manuals: Track[] = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, title: `M${i}`, artist: 'L' }));
    actions.playFrom([cur], 0);
    manuals.forEach((track) => actions.enqueue(track));

    actions.enterAutoMode();
    expect(state.playback.queue.map((t) => t.id).slice(0, 6)).toEqual([
      'current',
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
    ]);

    await vi.waitFor(() => expect(state.playback.queue.length).toBeGreaterThan(6));
    expect(state.playback.queue.slice(0, 6).map((t) => t.id)).toEqual([
      'current',
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
    actions.exitAutoMode();
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
    expect(api.relatedYouTube).toHaveBeenCalledWith('yt111111111', expect.any(AbortSignal), false);
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

  it('does not attach a stale radio mix after a new context is chosen', async () => {
    const pending = deferred<Array<{ id: string; title: string; channel: string }>>();
    const relatedYouTube = vi.fn().mockReturnValue(pending.promise);
    const { actions, state } = await loadStore({ relatedYouTube });
    actions.playFrom([seed], 0);

    const starting = actions.startRadio(seed);
    await vi.waitFor(() => expect(relatedYouTube).toHaveBeenCalled());
    actions.playFrom(
      [
        { id: 'fresh', title: 'Fresh', artist: 'B' },
        { id: 'fresh-next', title: 'Fresh next', artist: 'B' },
      ],
      0,
    );
    pending.resolve([{ id: 'stale-mix', title: 'Stale', channel: 'Radio' }]);
    await starting;

    expect(state.playback.radioMode).toBe(false);
    expect(state.playback.queue.map((track) => track.id)).toEqual(['fresh', 'fresh-next']);
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

describe('Solid store playback identity', () => {
  /** The Deezer row, the preview it resolves to, and the file it downloads as —
   * three ids for one song, which is exactly what used to break the highlight. */
  const row = {
    id: 'deezer:track:12345',
    type: 'track' as const,
    source: 'deezer',
    title: 'Song A',
    artist: 'Artist A',
    external_ids: { deezer_id: '12345' },
  };
  const preview: Track = { id: 'vid123', title: 'Song A', artist: 'Artist A', source: 'preview' };
  const downloaded: Track = { id: 'sha256', title: 'Song A', artist: 'Artist A', youtube_id: 'vid123' };

  it('marks the search row that started playback, with no id in common', async () => {
    const { actions, isPlayingItem } = await loadStore();
    expect(isPlayingItem(row)).toBe(false);
    actions.playTrack({ ...preview, originKeys: ['cat:deezer:track:12345', 'deezer:12345'] });
    expect(isPlayingItem(row)).toBe(true);
  });

  it('adopts the library twin identity the moment a download lands mid-song', async () => {
    const owned: Track = { ...downloaded, isrc: 'USRC12345678' };
    const getLibrary = vi
      .fn()
      .mockResolvedValueOnce({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] })
      .mockResolvedValue({ tracks: [owned], playlists: {}, settings: {}, podcast_subscriptions: [] });
    const { actions, playingKeys, isPlayingItem } = await loadStore({ getLibrary });

    actions.playTrack(preview);
    await actions.syncLibrary();
    // Streaming, nothing owned: the song answers to its video id and no more.
    expect(playingKeys().has('lib:sha256')).toBe(false);
    expect(playingKeys().has('isrc:USRC12345678')).toBe(false);

    // The download completes. `downloader_update` already calls syncLibrary();
    // the new library invalidates the index, which invalidates the key set —
    // playback is not touched and no extra request is made.
    await actions.syncLibrary();
    expect(playingKeys().has('lib:sha256')).toBe(true);
    // The twin's other identities come along, so a catalog row that only knows
    // the recording code now matches too.
    const byIsrc = { ...row, id: 'mb:abc', source: 'musicbrainz', external_ids: { isrc: 'us-rc1-23-45678' } };
    expect(isPlayingItem(byIsrc)).toBe(true);
  });

  it('recognises the downloaded copy as owned once the resolution is linked', async () => {
    const { actions, ownedTrackForItem } = await loadStore({
      getLibrary: vi
        .fn()
        .mockResolvedValue({ tracks: [downloaded], playlists: {}, settings: {}, podcast_subscriptions: [] }),
    });
    await actions.syncLibrary();
    // The row shares no id with the file it produced…
    expect(ownedTrackForItem(row)).toBeNull();
    // …until the catalog→video resolution is recorded.
    actions.linkCatalogItem(row.id, 'vid123');
    expect(ownedTrackForItem(row)?.id).toBe('sha256');
  });

  it('stops marking rows when playback stops', async () => {
    const { actions, isPlayingResult } = await loadStore();
    actions.playTrack(preview);
    expect(isPlayingResult({ id: 'vid123', title: 'Song A' })).toBe(true);
    expect(isPlayingResult({ id: 'othervid', title: 'Song A' })).toBe(false);
  });
});

describe('Solid store favourites', () => {
  const preview = {
    id: 'dQw4w9WgXcQ',
    title: 'Weightless',
    artist: 'Marconi Union',
    duration: 490,
    source: 'preview' as const,
  };

  it('saves a song that is not downloaded, and lists it as playable', async () => {
    const { actions, state, favouriteTracks, api } = await loadStore({
      toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
    });

    actions.toggleFavouriteTrack(preview);

    expect(state.saved[0].keys).toEqual(['yt:dQw4w9WgXcQ']);
    expect(api.toggleFavourite).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ['yt:dQw4w9WgXcQ'], title: 'Weightless' }),
    );
    expect(favouriteTracks().map((t) => t.id)).toEqual(['dQw4w9WgXcQ']);
  });

  it('lights the heart for the same song under any of its ids', async () => {
    const { actions, isFavouriteTrack, isFavouriteResult } = await loadStore({
      toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
    });

    actions.toggleFavouriteTrack(preview);

    // Saved as a preview; recognised as the downloaded file, which shares only
    // the video id, and as the search result it came from.
    expect(
      isFavouriteTrack({ id: 'hash9f2a', title: 'Weightless', artist: 'Marconi Union', youtube_id: 'dQw4w9WgXcQ' }),
    ).toBe(true);
    expect(isFavouriteResult({ id: 'dQw4w9WgXcQ', title: 'Weightless' })).toBe(true);
    expect(isFavouriteTrack({ id: 'other', title: 'Something else', artist: 'X' })).toBe(false);
  });

  it('turns a saved preview into the owned track once the library has it', async () => {
    const owned = {
      id: 'hash9f2a',
      title: 'Weightless',
      artist: 'Marconi Union',
      duration: 490,
      youtube_id: 'dQw4w9WgXcQ',
    };
    const { actions, favouriteTracks, favouriteLibraryIds } = await loadStore({
      toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
      getLibrary: vi
        .fn()
        .mockResolvedValueOnce({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] })
        .mockResolvedValueOnce({ tracks: [owned], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      // The engine stores the entry exactly as it was saved — it never learns
      // the library id, because it does not need to.
      getSaved: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { keys: ['yt:dQw4w9WgXcQ'], title: 'Weightless', artist: 'Marconi Union', duration: 490, favourite: true },
        ]),
    });

    await actions.syncLibrary();
    actions.toggleFavouriteTrack(preview);
    expect(favouriteTracks()[0].source).toBe('preview');
    expect(favouriteLibraryIds().size).toBe(0);

    // The download lands; nothing about the favourite is rewritten.
    await actions.syncLibrary();
    expect(favouriteTracks()[0].id).toBe('hash9f2a');
    expect(favouriteTracks()[0].source).toBeUndefined();
    expect([...favouriteLibraryIds()]).toEqual(['hash9f2a']);
  });

  it('unmarks by identity, not by the id the surface happens to hold', async () => {
    const { actions, state, isFavouriteTrack, isSavedTrack } = await loadStore({
      toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
    });

    actions.toggleFavouriteTrack(preview);
    // Unmarked from the library row, which shares only the video id.
    actions.toggleFavouriteTrack({
      id: 'hash9f2a',
      title: 'Weightless',
      artist: 'Marconi Union',
      youtube_id: 'dQw4w9WgXcQ',
    });

    expect(isFavouriteTrack(preview)).toBe(false);
    // Taking the mark off is not taking the song away: it is still yours.
    expect(state.saved).toHaveLength(1);
    expect(isSavedTrack(preview)).toBe(true);
  });

  it('saves without marking, and marks what it saved', async () => {
    const { actions, state, isSavedTrack, isFavouriteTrack, api } = await loadStore();

    actions.toggleSavedTrack(preview);
    expect(api.toggleSaved).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ['yt:dQw4w9WgXcQ'], title: 'Weightless' }),
    );
    expect(isSavedTrack(preview)).toBe(true);
    expect(isFavouriteTrack(preview)).toBe(false);

    actions.toggleFavouriteTrack(preview);
    expect(isFavouriteTrack(preview)).toBe(true);
    // One song, one entry — marking did not save a second copy of it.
    expect(state.saved).toHaveLength(1);
  });

  it('unsaving takes the mark with it — there is nothing left to mark', async () => {
    const { actions, state, isSavedTrack, isFavouriteTrack } = await loadStore();

    actions.toggleFavouriteTrack(preview);
    expect(isFavouriteTrack(preview)).toBe(true);

    actions.toggleSavedTrack(preview);
    expect(state.saved).toEqual([]);
    expect(isSavedTrack(preview)).toBe(false);
    expect(isFavouriteTrack(preview)).toBe(false);
  });

  it('counts a downloaded song as in the library without an entry of its own', async () => {
    const owned = { id: 'hash9f2a', title: 'Weightless', artist: 'Marconi Union', youtube_id: 'dQw4w9WgXcQ' };
    const { actions, isSavedTrack, isFavouriteTrack } = await loadStore({
      getLibrary: vi
        .fn()
        .mockResolvedValue({ tracks: [owned], playlists: {}, settings: {}, podcast_subscriptions: [] }),
    });

    await actions.syncLibrary();

    // Having the file *is* having the song, so the heart is offered over it —
    // and the search result it came from answers the same way.
    expect(isSavedTrack(owned)).toBe(true);
    expect(isSavedTrack(preview)).toBe(true);
    expect(isFavouriteTrack(owned)).toBe(false);
  });

  it('shows songs held without a file in the library, and drops them once downloaded', async () => {
    const owned = { id: 'hash9f2a', title: 'Weightless', artist: 'Marconi Union', youtube_id: 'dQw4w9WgXcQ' };
    const other = { id: 't1', title: 'One', artist: 'Artist' };
    const { actions, musicLibrary } = await loadStore({
      getLibrary: vi
        .fn()
        .mockResolvedValueOnce({ tracks: [other], playlists: {}, settings: {}, podcast_subscriptions: [] })
        .mockResolvedValue({ tracks: [other, owned], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getSaved: vi
        .fn()
        .mockResolvedValue([{ keys: ['yt:dQw4w9WgXcQ'], title: 'Weightless', artist: 'Marconi Union' }]),
    });

    await actions.syncLibrary();
    // Browsable exactly like a file, which is the point of saving it.
    expect(musicLibrary().map((t) => t.id)).toEqual(['t1', 'dQw4w9WgXcQ']);

    // The download lands: the same song, now as its file — listed once, not twice.
    await actions.syncLibrary();
    expect(musicLibrary().map((t) => t.id)).toEqual(['t1', 'hash9f2a']);
  });

  it('reverts the optimistic save when the engine rejects it', async () => {
    const { actions, state } = await loadStore({
      toggleFavourite: vi.fn().mockRejectedValue(new Error('offline')),
    });

    actions.toggleFavouriteTrack(preview);
    expect(state.saved).toHaveLength(1);

    await flush();
    expect(state.saved).toEqual([]);
  });

  it('keeps a favourite when its file is deleted — that frees disk, it does not unsave', async () => {
    const owned = { id: 't1', title: 'One', artist: 'Artist', duration: 180, youtube_id: 'dQw4w9WgXcQ' };
    const { actions, state, favouriteTracks } = await loadStore({
      toggleFavourite: vi.fn().mockResolvedValue({ is_favourite: true }),
      getLibrary: vi
        .fn()
        .mockResolvedValueOnce({ tracks: [owned], playlists: {}, settings: {}, podcast_subscriptions: [] })
        .mockResolvedValue({ tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getSaved: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue(state_favourite_after_delete()),
    });

    await actions.syncLibrary();
    actions.toggleFavouriteTrack(owned);
    expect(favouriteTracks()[0].id).toBe('t1');

    await actions.deleteTrack('t1');

    expect(state.library).toEqual([]);
    // Still saved, now as a stream rather than a file.
    expect(state.saved).toHaveLength(1);
    expect(favouriteTracks()[0].source).toBe('preview');
    expect(favouriteTracks()[0].id).toBe('dQw4w9WgXcQ');
  });
});

/** What the engine returns after the track behind a favourite is deleted: the
 * entry is untouched, it simply no longer resolves to anything local. */
function state_favourite_after_delete() {
  return [
    {
      keys: ['lib:t1', 'yt:dQw4w9WgXcQ'],
      title: 'One',
      artist: 'Artist',
      duration: 180,
      favourite: true,
    },
  ];
}
