import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const t1: Track = { id: 't1', title: 'One', artist: 'Artist', duration: 180 };
const t2: Track = { id: 't2', title: 'Two', artist: 'Artist', duration: 200 };

function autoPlan(ids: string[]) {
  return {
    v: 5 as const,
    plan_id: 'auto-plan', intent: 'auto_mode' as const, profile: 'balanced' as const,
    dj_profile: 'adaptive' as const, source_profile: 'balanced' as const,
    seed_identity: 'seed', degraded: false, generated_at: 1,
    pool_counts: { local: 0, related: ids.length, discovery: 0 }, requests: [],
    items: ids.map((id) => ({
      id, youtube_id: id, title: id, artist: 'Generated', source: 'preview' as const,
      source_pool: 'related' as const, recommendation_identity: `music:youtube:${id}`,
      recommendation_source: 'auto_mode' as const,
    })),
  };
}

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

/**
 * A stand-in for the OS media controls — a lock screen, a steering wheel, a car
 * head unit. jsdom has none, and `initStore` registers the handlers on import,
 * so this has to be in place before the store is loaded.
 */
function stubMediaSession() {
  const handlers = new Map<string, (details?: unknown) => void>();
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: (details?: unknown) => void) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: mediaSession,
  });
  vi.stubGlobal('MediaMetadata', class { constructor(init: unknown) { Object.assign(this, init); } });
  return { mediaSession, press: (action: string) => handlers.get(action)?.() };
}

async function loadStore(
  apiOverrides: Record<string, unknown> = {},
  audioOverrides: Record<string, unknown> = {},
) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('device_id', 'dev1');

  const relatedYouTube = (
    apiOverrides.relatedYouTube as ((
      id: string,
      signal?: AbortSignal,
      enrich?: boolean,
    ) => Promise<Array<Record<string, unknown>>>) | undefined
  ) ?? vi.fn().mockResolvedValue([]);
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
    relatedYouTube,
    emitDiscoveryEvent: vi.fn().mockResolvedValue(undefined),
    placeDjTrack: vi.fn().mockImplementation(async (body: { track: Track; requested_queue_id: string; route: Array<{ queue_id: string }> }) => ({
      v: 1,
      insert_at: Math.min(1, body.route.length),
      before_queue_id: body.route[1]?.queue_id ?? null,
      requested_queue_id: body.requested_queue_id,
      items: [{
        id: body.track.id,
        youtube_id: body.track.id,
        title: body.track.title,
        artist: body.track.artist,
        source: 'preview',
        source_pool: 'related',
        recommendation_identity: `music:youtube:${body.track.id}`,
        recommendation_source: 'auto_mode',
        route_kind: 'user',
        request_id: body.requested_queue_id,
      }],
      degraded: false,
    })),
    // Echoes the posted route straight back: a repair that changes nothing is
    // still a repair, and it keeps every assertion about what the *client* does
    // with the answer independent of what the planner chose.
    repairDjRoute: vi.fn().mockImplementation(async (body: {
      route: Array<{ queue_id: string; route_kind: string; title?: string; artist?: string }>;
    }) => ({
      v: 1,
      items: body.route.map((ref) => ({
        id: ref.queue_id,
        youtube_id: ref.queue_id,
        title: ref.title ?? ref.queue_id,
        artist: ref.artist ?? 'Generated',
        source: 'preview',
        source_pool: 'related',
        recommendation_identity: `music:youtube:${ref.queue_id}`,
        recommendation_source: 'auto_mode',
        queue_id: ref.queue_id,
        route_kind: ref.route_kind,
        transition: { technique: 'long_blend', score: 0.8 },
      })),
      dropped: [],
      degraded: false,
    })),
    sendPlayTiming: vi.fn().mockResolvedValue({ status: 'ok' }),
    getDiscoverySettings: vi.fn().mockResolvedValue({ learning_enabled: true, autoplay_enabled: true }),
    setAutoplayEnabled: vi.fn().mockResolvedValue({ autoplay_enabled: true }),
    setVolumeLeveling: vi.fn().mockResolvedValue({ volume_leveling: true }),
    requestLoudness: vi.fn().mockResolvedValue({ queued: 0 }),
    ...apiOverrides,
  } as Record<string, any>;
  if (!apiOverrides.planMusicQueue) {
    api.planMusicQueue = vi.fn(async (body: {
      intent: 'autoplay' | 'radio' | 'auto_mode';
      profile: 'familiar' | 'balanced' | 'explore';
      seed: { youtube_id?: string };
    }, signal?: AbortSignal) => {
      const rows = await relatedYouTube(body.seed.youtube_id ?? '', signal, false);
      return {
        v: 1,
        plan_id: `plan-${body.intent}`,
        intent: body.intent,
        profile: body.profile,
        seed_identity: body.seed.youtube_id ?? '',
        degraded: rows.length === 0,
        generated_at: 1,
        pool_counts: { local: 0, related: rows.length, discovery: 0 },
        items: rows.map((row: Record<string, unknown>) => ({
          id: String(row.id ?? ''),
          youtube_id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          artist: String(row.channel ?? ''),
          duration: typeof row.duration === 'number' ? row.duration : undefined,
          cover: typeof row.thumbnail === 'string' ? row.thumbnail : undefined,
          source: 'preview',
          source_pool: 'related',
          recommendation_identity: `music:youtube:${String(row.id ?? '')}`,
          recommendation_source: body.intent,
        })),
      };
    });
  }
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
    unlockAudio: vi.fn(() => false),
    graphReady: vi.fn(() => false),
    stage: vi.fn(),
    clearStaged: vi.fn(),
    takeStaged: vi.fn(() => null),
    mixPhase: vi.fn(() => 'idle' as const),
    mixIsDominant: vi.fn(() => false),
    cancelMix: vi.fn(),
    startMixNow: vi.fn(() => false),
    armTransition: vi.fn().mockResolvedValue(undefined),
    setLevels: vi.fn(),
    setLevelingEnabled: vi.fn(),
    levelingEnabled: vi.fn(() => true),
    ...audioOverrides,
  };

  // `request` is the raw helper the discover cache uses directly; initStore
  // warms it, so the mock has to cover it too.
  vi.doMock('../lib/api', () => ({ api, request: vi.fn().mockResolvedValue({}) }));
  const deck = {
    duration: 180,
    currentTime: 0,
    paused: false,
    ended: false,
    currentSrc: '',
    getAttribute: vi.fn((name: string) => name === 'src' ? deck.currentSrc : null),
  } as unknown as HTMLAudioElement;
  /** Media events the store bound, so a test can fire one the way a deck would. */
  const deckHandlers = new Map<string, ((event: Event) => void)[]>();
  const fireDeckEvent = (type: string) => {
    for (const handler of deckHandlers.get(type) ?? []) {
      handler({ currentTarget: deck } as unknown as Event);
    }
  };
  vi.doMock('../lib/audio', () => ({
    audioEl: vi.fn(() => deck),
    onDeckEvent: vi.fn((type: string, handler: (event: Event) => void) => {
      const list = deckHandlers.get(type) ?? [];
      list.push(handler);
      deckHandlers.set(type, list);
    }),
    isActiveDeck: vi.fn(() => true),
    setGraphReporter: vi.fn(),
    audioService,
    storedVolume: () => 1,
    isCurrentLoad: () => true,
  }));
  // Faithful about *arity*, on purpose. These used to swallow any extra
  // argument, which is how a per-play attempt id rode into the stream URL —
  // making every play a fresh cache key — without a single test noticing. Now
  // anything the store passes beyond the id shows up in the URL, so a URL that
  // varies between two plays of the same track fails a test instead of a drive.
  const extra = (rest: unknown[]) => (rest.length ? `?${rest.join('&')}` : '');
  vi.doMock('../lib/media', () => ({
    streamUrl: (id: string, ...rest: unknown[]) => `/stream/${id}${extra(rest)}`,
    previewUrl: (id: string, ...rest: unknown[]) => `/preview/${id}${extra(rest)}`,
    playbackYoutubeId: (track: { id: string; youtube_id?: string | null; source?: 'preview' }) =>
      track.source === 'preview' ? track.id : track.youtube_id || null,
    podcastStreamUrl: (id: string, ...rest: unknown[]) => `/podcast/${id}${extra(rest)}`,
    coverUrl: (id: string) => `/cover/${id}`,
    bustCovers: vi.fn(),
  }));
  const toastAction = vi.fn();
  vi.doMock('../lib/toast', () => ({
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(() => ({ update: vi.fn(), dismiss: vi.fn() })),
      action: toastAction,
    },
  }));
  vi.doMock('../lib/haptics', () => ({ vibrate: vi.fn() }));
  /** Events the store subscribed to, so a test can send one the way the engine
   * would — a remote control command, a handoff from another device. */
  const socketHandlers = new Map<string, (data?: unknown) => void>();
  vi.doMock('../lib/socket', () => ({
    createSocket: vi.fn(() => ({
      on: (event: string, handler: (data?: unknown) => void) => socketHandlers.set(event, handler),
      emit: vi.fn(),
      disconnect: vi.fn(),
    })),
    dispatchDiscoverSeed: vi.fn(),
  }));

  const store = await import('./index');
  const fireSocketEvent = (event: string, data?: unknown) => socketHandlers.get(event)?.(data);
  return { ...store, api, audioService, deck, fireDeckEvent, fireSocketEvent, toastAction };
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
    expect(audioService.prime).toHaveBeenCalledWith('/stream/t1', 37, 1);
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

  it('does not report a failed same-device preload as a playback failure on boot', async () => {
    const { initStore, state, deck, fireDeckEvent, audioService } = await loadStore({
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
    const { toast } = await import('../lib/toast');

    initStore();
    await flush();

    expect(audioService.prime).toHaveBeenCalledWith('/stream/t1', 37, 1);
    (deck as unknown as { currentSrc: string }).currentSrc = '/stream/t1';
    fireDeckEvent('error');

    expect(state.playback.phase).toBe('paused');
    expect(state.playback.loadError).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
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

describe('volume levelling', () => {
  const measured: Track = {
    id: 'loud', title: 'Loud', artist: 'Artist', duration: 200,
    loudness_lufs: -6, loudness_peak_dbtp: -1,
  };

  it('attenuates a measured track and leaves an unmeasured one alone', async () => {
    const { actions, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        tracks: [measured], playlists: {}, settings: {}, podcast_subscriptions: [],
      }),
    });
    await flush();

    actions.playTrack(measured);
    expect(audioService.load).toHaveBeenLastCalledWith('/stream/loud', expect.any(Number));
    // -6 LUFS against a -14 target, with 0 dB of headroom to the ceiling.
    expect(audioService.load.mock.lastCall?.[1]).toBeCloseTo(10 ** (-8 / 20), 4);

    actions.playTrack(t2);
    // Nothing has measured t2, so it plays exactly as it always did.
    expect(audioService.load).toHaveBeenLastCalledWith('/stream/t2', 1);
  });

  it('reads the measurement from the library when the queue entry predates it', async () => {
    const { actions, state, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        tracks: [measured], playlists: {}, settings: {}, podcast_subscriptions: [],
      }),
    });
    await flush();

    // A queue entry is a snapshot taken when the track was enqueued, so a song
    // the sweep measured afterwards carries the numbers only on the library copy.
    await actions.syncLibrary();
    const stale: Track = { id: 'loud', title: 'Loud', artist: 'Artist', duration: 200 };
    actions.playTrack(stale);

    expect(state.library[0].loudness_lufs).toBe(-6);
    expect(audioService.load.mock.lastCall?.[1]).toBeLessThan(1);
  });

  it('levels a whole album to one reference, from the library copies', async () => {
    const loud: Track = {
      id: 'a1', title: 'Opener', artist: 'Artist', album: 'Record', duration: 200,
      loudness_lufs: -8, loudness_peak_dbtp: -1,
    };
    const interlude: Track = {
      id: 'a2', title: 'Interlude', artist: 'Artist', album: 'Record', duration: 60,
      loudness_lufs: -24, loudness_peak_dbtp: -12,
    };
    const { actions, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        tracks: [loud, interlude], playlists: {}, settings: {}, podcast_subscriptions: [],
      }),
    });
    await actions.syncLibrary();

    // Queued as an album, from snapshots that predate the measurements — the
    // path where album levelling used to fall back to per-track without saying so.
    const stale = [
      { id: 'a1', title: 'Opener', artist: 'Artist', album: 'Record', duration: 200 },
      { id: 'a2', title: 'Interlude', artist: 'Artist', album: 'Record', duration: 60 },
    ] as Track[];
    actions.playFrom(stale, 0, { context: { id: 'album:record', kind: 'album', label: 'Record' } });
    const first = audioService.load.mock.lastCall?.[1] as number;

    actions.next();
    const second = audioService.load.mock.lastCall?.[1] as number;

    // One reference for the record, so the quiet interlude stays 16 dB quieter
    // than the opener, exactly as it was mastered.
    expect(second).toBeCloseTo(first, 6);
  });

  it('asks for the same URL every time a track is played', async () => {
    // The URL is the browser's cache key. When it carried a per-play attempt id
    // every play was a cold fetch of a file the browser already had in full —
    // invisible on a LAN, seconds of spinner over a remote link.
    const { actions, audioService } = await loadStore();

    actions.playTrack(t1);
    const first = audioService.load.mock.lastCall?.[0];
    actions.playTrack(t2);
    actions.playTrack(t1);
    const second = audioService.load.mock.lastCall?.[0];

    expect(first).toBe(second);
    expect(first).not.toContain('?');
  });

  it('never asks the engine to measure what the library already knows', async () => {
    // Asking is not free: the engine used to answer it by reading the whole
    // library, on the same hub that was streaming the song being started. A
    // queue entry predating the measurement is the common case, so testing the
    // snapshot rather than the library meant asking again for every track, for
    // ever.
    const { actions, api, state, initStore, fireDeckEvent } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        tracks: [measured], playlists: {}, settings: {}, podcast_subscriptions: [],
      }),
    });
    initStore();
    await actions.syncLibrary();
    await flush();
    expect(state.library[0].loudness_lufs).toBe(-6);

    actions.playFrom([{ id: 'loud', title: 'Loud', artist: 'Artist', duration: 200 }], 0);
    fireDeckEvent('playing');
    await flush();

    expect(api.requestLoudness).not.toHaveBeenCalled();
  });

  it('asks at most once for the same track', async () => {
    const { actions, api, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    fireDeckEvent('playing');
    await flush();
    expect(api.requestLoudness).toHaveBeenCalledTimes(1);
    expect(api.requestLoudness).toHaveBeenCalledWith(['t1', 't2']);

    actions.next();
    fireDeckEvent('playing');
    await flush();
    // The engine only announces new measurements every few minutes. Re-sending
    // the same ids in the meantime is work nobody is waiting for.
    expect(api.requestLoudness).toHaveBeenCalledTimes(1);
  });

  it('never downloads the next track while the current one is still starting', async () => {
    // A staged deck pulls the whole of the next track. Starting that alongside
    // the song the listener just clicked puts two full files on the link at
    // once — measured on one session, eight clicks moved 171 MB and every
    // click had to share the connection with the song after it.
    const { actions, api, audioService, deck, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    await flush();
    expect(audioService.stage).not.toHaveBeenCalled();
    expect(api.requestLoudness).not.toHaveBeenCalled();

    // Still not when it starts sounding: there is a whole track to do it in.
    fireDeckEvent('playing');
    await flush();
    expect(audioService.stage).not.toHaveBeenCalled();
    expect(api.requestLoudness).toHaveBeenCalled();

    // Inside the last minute, where nothing is waiting on the link.
    (deck as unknown as { currentTime: number }).currentTime = 130;
    fireDeckEvent('timeupdate');
    await flush();
    expect(audioService.stage).toHaveBeenCalledWith('/stream/t2', expect.any(Number));
  });

  it('plays everything at unity while the setting is off', async () => {
    const { actions, audioService } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        tracks: [measured], playlists: {}, settings: {}, podcast_subscriptions: [],
      }),
    });
    await actions.syncLibrary();
    await actions.setVolumeLeveling(false);

    actions.playTrack(measured);
    expect(audioService.load).toHaveBeenLastCalledWith('/stream/loud', 1);
    expect(audioService.setLevelingEnabled).toHaveBeenCalledWith(false);
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
    expect(audioService.load).toHaveBeenLastCalledWith('/preview/previewid02', 1);
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
  it('drops generated branches but preserves the manual queue and playback preferences on exit', async () => {
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
    expect(state.playback.queue.map((track) => track.id)).toEqual(['current', 'manual']);
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

  it('keeps Auto and treats a manual Play action as an immediate pivot', async () => {
    const { actions, state } = await loadStore({
      relatedYouTube: vi.fn().mockResolvedValue([]),
      searchYouTube: vi.fn().mockResolvedValue([{ id: 'yt-current' }]),
    });
    const current: Track = { id: 'current', title: 'Current', artist: 'A', youtube_id: 'yt-current' };
    const later: Track = { id: 'later', title: 'Later', artist: 'B' };
    const now: Track = { id: 'now', title: 'Now', artist: 'C' };
    actions.playFrom([current], 0);
    actions.enterAutoMode();

    actions.enqueue(later);
    actions.playNext({ ...later, id: 'next' });
    expect(state.autoMode.active).toBe(true);

    actions.playNow(now);
    expect(state.autoMode.active).toBe(true);
    expect(state.playback.currentTrack?.id).toBe('now');
    expect(state.autoMode.sources).toEqual([]);
    expect(state.autoMode.heard.at(-1)).toMatchObject(now);
  });

  it('can enter empty and a source never implies playback', async () => {
    const { actions, state } = await loadStore();
    actions.enterAutoMode();
    expect(state.autoMode.active).toBe(true);
    expect(state.autoMode.sources).toEqual([]);
    expect(state.playback.currentTrack).toBeNull();

    const source: Track = { id: 'source', title: 'Source', artist: 'Artist' };
    actions.addAutoSource([source], 'My selection');
    expect(state.playback.currentTrack).toBeNull();
    expect(state.autoMode.sources[0]).toMatchObject({ label: 'My selection', activation: 1 });
  });

  it('starts an empty Auto session only when a song is placed in the route', async () => {
    const { actions, state } = await loadStore();
    actions.enterAutoMode();
    const placed: Track = { id: 'placed', title: 'Placed', artist: 'Listener' };

    await actions.placeAutoTrack(placed);

    expect(state.playback.currentTrack?.id).toBe('placed');
    expect(state.playback.queue[0].autoRoute).toMatchObject({ kind: 'user', placement: 'dj' });
    expect(state.autoMode.sources).toEqual([]);
  });

  it('adds a running source and replans generated music without implying playback', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 8 }, (_, index) => `route-${index}`)));
    const { actions, state } = await loadStore({ planDjQueue });
    const current: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
    actions.playFrom([current], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(9));
    const routeBefore = state.playback.queue.map((track) => track.queueId);

    actions.useAutoTrackAsSource(state.playback.queue[2]);

    expect(state.autoMode.sources.at(-1)).toMatchObject({ activation: 1, tracks: [expect.objectContaining({ id: 'route-1' })] });
    await vi.waitFor(() => expect(planDjQueue).toHaveBeenCalledTimes(2));
    expect(state.playback.queue[0].queueId).toBe(routeBefore[0]);
  });

  it('places a song in the existing route without making it a source or replacing neighbours', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 5 }, (_, index) => `route-${index}`)));
    const { actions, state } = await loadStore({ planDjQueue });
    const current: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
    actions.playFrom([current], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(6));
    const neighbours = state.playback.queue.slice(1).map((entry) => entry.queueId);

    await actions.placeAutoTrack({ id: 'wanted', title: 'Wanted', artist: 'Listener' });

    const placed = state.playback.queue.find((entry) => entry.id === 'wanted');
    expect(placed?.autoRoute).toMatchObject({ kind: 'user', placement: 'dj' });
    expect(state.autoMode.sources).toEqual([]);
    expect(state.playback.queue.slice(1).filter((entry) => entry.id !== 'wanted').map((entry) => entry.queueId)).toEqual(neighbours);
    expect(planDjQueue).toHaveBeenCalledTimes(1);
  });

  it('carries a bridge with the song it leads into, and pins only the song', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(['route-0', 'route-1', 'route-2', 'route-3']));
    const placeDjTrack = vi.fn().mockImplementation(async (body: { track: Track; requested_queue_id: string }) => ({
      v: 1,
      insert_at: 0,
      before_queue_id: null,
      requested_queue_id: body.requested_queue_id,
      items: [
        {
          id: 'bridge', youtube_id: 'bridge', title: 'Bridge', artist: 'DJ', source: 'preview',
          source_pool: 'related', recommendation_identity: 'music:youtube:bridge',
          recommendation_source: 'auto_mode', route_kind: 'bridge',
        },
        {
          id: body.track.id, youtube_id: body.track.id, title: body.track.title, artist: body.track.artist,
          source: 'preview', source_pool: 'related', recommendation_identity: `music:youtube:${body.track.id}`,
          recommendation_source: 'auto_mode', route_kind: 'user', request_id: body.requested_queue_id,
        },
      ],
      degraded: false,
    }));
    const { actions, state } = await loadStore({ planDjQueue, placeDjTrack });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(5));

    await actions.placeAutoTrack({ id: 'wanted', title: 'Wanted', artist: 'Listener' });
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(7));
    const bridge = state.playback.queue.find((entry) => entry.id === 'bridge')!;
    const wanted = state.playback.queue.find((entry) => entry.id === 'wanted')!;
    expect(bridge.autoRoute).toMatchObject({ kind: 'bridge', ownerQueueId: wanted.queueId });

    // Grabbing the bridge is a request to move what it leads into: on its own
    // it connects nothing, and it used to be deleted out from under the drag.
    actions.moveAutoRoute(bridge.queueId);

    expect(state.playback.queue.map((entry) => entry.id).slice(-2)).toEqual(['bridge', 'wanted']);
    expect(state.playback.queue.filter((entry) => entry.id === 'bridge')).toHaveLength(1);
    expect(state.playback.queue.at(-1)!.autoRoute).toMatchObject({ kind: 'user', placement: 'fixed' });
    expect(state.playback.queue.at(-2)!.autoRoute).toMatchObject({ kind: 'bridge', ownerQueueId: wanted.queueId });
  });

  it('never moves a route entry in front of the song that is playing', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(['route-0', 'route-1', 'route-2']));
    const { actions, state } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(4));
    const last = state.playback.queue[3];

    actions.moveAutoRoute(last.queueId, state.playback.queue[0].queueId);

    expect(state.playback.queue[0].id).toBe('current');
    expect(state.playback.queue[1].queueId).toBe(last.queueId);
    expect(state.playback.index).toBe(0);
  });

  it('names the joins a move opens and offers the repair that closes them', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(['route-0', 'route-1', 'route-2', 'route-3']));
    const { actions, state, toastAction } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(5));
    const [, moved, closed, before] = state.playback.queue;

    actions.moveAutoRoute(moved.queueId, before.queueId);

    // The three joins that changed: into the moved song, into the one that
    // closed over the gap it left, and into the one it now sits in front of.
    expect([...state.autoMode.staleSeams].sort())
      .toEqual([moved.queueId, closed.queueId, before.queueId].sort());
    expect(state.playback.queue.map((entry) => entry.queueId))
      .toEqual([state.playback.queue[0].queueId, closed.queueId, moved.queueId, before.queueId, state.playback.queue[4].queueId]);
    expect(toastAction.mock.calls.at(-1)![1]).toBe('Fix mix');

    toastAction.mock.calls.at(-1)![2]();
    await vi.waitFor(() => expect(state.autoMode.staleSeams).toEqual([]));
  });

  it('composes source membership with an existing route occurrence independently', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(['route-0', 'route-1']));
    const { actions, state } = await loadStore({ planDjQueue });
    const current: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
    actions.playFrom([current], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(3));
    const occurrence = state.playback.queue[1];

    actions.useAutoTrackAsSource(occurrence);
    expect(state.autoMode.sources.at(-1)?.tracks[0].id).toBe(occurrence.id);
    expect(state.playback.queue.some((entry) => entry.queueId === occurrence.queueId)).toBe(true);
    actions.removeAutoSource(state.autoMode.sources.at(-1)!.id);
    expect(state.playback.queue.some((entry) => entry.queueId === occurrence.queueId)).toBe(true);
  });

  it('distinguishes neutral removal from an exact session avoidance', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 8 }, (_, index) => `route-${index}`)));
    const { actions, state, toastAction } = await loadStore({ planDjQueue });
    const current: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
    actions.playFrom([current], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(9));

    actions.removeAutoRouteOccurrence(state.playback.queue[1].queueId);
    expect(state.autoMode.avoidedIdentities).toEqual([]);
    const avoided = state.playback.queue[1];
    actions.avoidAutoTrackForSession(avoided.queueId);
    // Captured now: the removal above left a toast of its own behind, and that
    // one escalates rather than undoes.
    const undoAvoidance = toastAction.mock.calls.at(-1)![2];
    expect(state.autoMode.avoidedIdentities).toEqual([`music:youtube:${avoided.id}`]);
    expect(state.playback.queue.some((track) => track.queueId === avoided.queueId)).toBe(false);

    actions.playNow({ id: 'pivot', title: 'Pivot', artist: 'Other' });
    await vi.waitFor(() => expect(planDjQueue).toHaveBeenCalledTimes(2));
    expect(planDjQueue.mock.calls[1][0].exclude).toContain(`music:youtube:${avoided.id}`);

    undoAvoidance();
    expect(state.autoMode.avoidedIdentities).toEqual([]);
    actions.exitAutoMode();
    expect(state.autoMode.avoidedIdentities).toEqual([]);
  });

  it('lets a plain removal become an avoidance from its own toast', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 8 }, (_, index) => `route-${index}`)));
    const { actions, state, toastAction } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(9));

    const dropped = state.playback.queue[1];
    actions.removeAutoRouteOccurrence(dropped.queueId);
    expect(state.autoMode.avoidedIdentities).toEqual([]);
    expect(toastAction.mock.calls[0][1]).toBe('Avoid during this session');

    toastAction.mock.calls[0][2]();
    expect(state.autoMode.avoidedIdentities).toEqual([`music:youtube:${dropped.id}`]);
  });

  it('keeps every pinned song, in order, when the route is repaired', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 8 }, (_, index) => `route-${index}`)));
    const { actions, state, api } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(9));

    await actions.placeAutoTrack({ id: 'mine', title: 'Mine', artist: 'Listener', source: 'preview' });
    const pinned = state.playback.queue.find((entry) => entry.id === 'mine')!;
    await actions.repairAutoRoute();

    const posted = api.repairDjRoute.mock.calls[0][0];
    expect(posted.route.filter((ref: { route_kind: string }) => ref.route_kind === 'user'))
      .toEqual([expect.objectContaining({ queue_id: pinned.queueId })]);
    const kept = state.playback.queue.find((entry) => entry.queueId === pinned.queueId);
    expect(kept?.autoRoute).toMatchObject({ kind: 'user' });
    expect(state.autoMode.repairing).toBe(false);
  });

  it('keeps an explicitly queued song through a repair', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 8 }, (_, index) => `route-${index}`)));
    const { actions, state, api } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(9));

    actions.enqueue({ id: 'asked-for', title: 'Asked for', artist: 'Listener', source: 'preview' });
    const manual = state.playback.queue.find((entry) => entry.id === 'asked-for')!;
    expect(manual.queueLane).toBe('manual');

    await actions.repairAutoRoute();

    // A song asked for by name has no `autoRoute`, but it is every bit as
    // pinned as one that was dragged: the planner must be told so.
    const posted = api.repairDjRoute.mock.calls[0][0];
    expect(posted.route.find((ref: { queue_id: string }) => ref.queue_id === manual.queueId).route_kind).toBe('user');
    const survivor = state.playback.queue.find((entry) => entry.queueId === manual.queueId);
    expect(survivor?.queueLane).toBe('manual');
  });

  it('rebuilds the chain so every repaired entry names the track it mixes out of', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 4 }, (_, index) => `route-${index}`)));
    const { actions, state } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(5));

    await actions.repairAutoRoute();

    const upcoming = state.playback.queue.slice(1);
    let previous = 'yt-current';
    for (const entry of upcoming) {
      expect(state.autoMode.plan[entry.queueId]?.fromKey).toBe(previous);
      previous = entry.youtube_id ?? entry.id;
    }
  });

  it('leaves the route exactly as it was when a repair fails', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 4 }, (_, index) => `route-${index}`)));
    const repairDjRoute = vi.fn().mockRejectedValue(new Error('offline'));
    const { actions, state } = await loadStore({ planDjQueue, repairDjRoute });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(5));
    const before = state.playback.queue.map((entry) => entry.queueId);
    const plan = { ...state.autoMode.plan };

    await actions.repairAutoRoute();

    expect(state.playback.queue.map((entry) => entry.queueId)).toEqual(before);
    expect(state.autoMode.plan).toEqual(plan);
    expect(state.autoMode.activity?.status).toBe('error');
    expect(state.autoMode.repairing).toBe(false);
  });

  it('discards a repair that answers for a route the listener has already changed', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 6 }, (_, index) => `route-${index}`)));
    const gate = deferred<unknown>();
    const repairDjRoute = vi.fn().mockReturnValue(gate.promise);
    const { actions, state } = await loadStore({ planDjQueue, repairDjRoute });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(7));

    const pending = actions.repairAutoRoute();
    const posted = repairDjRoute.mock.calls[0][0];
    actions.removeAutoRouteOccurrence(state.playback.queue[2].queueId);
    const after = state.playback.queue.map((entry) => entry.queueId);

    gate.resolve({
      v: 1,
      items: posted.route.map((ref: { queue_id: string; route_kind: string }) => ({
        id: ref.queue_id, youtube_id: ref.queue_id, title: ref.queue_id, artist: 'Generated',
        source: 'preview', source_pool: 'related',
        recommendation_identity: `music:youtube:${ref.queue_id}`, recommendation_source: 'auto_mode',
        queue_id: ref.queue_id, route_kind: ref.route_kind,
      })),
      dropped: [], degraded: false,
    });
    await pending;

    expect(state.playback.queue.map((entry) => entry.queueId)).toEqual(after);
    expect(state.autoMode.activity?.key).toBe('autoMode.agent.repairSkipped');
  });

  it('refuses a repair that came back missing one of the listener’s songs', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 6 }, (_, index) => `route-${index}`)));
    const { actions, state, api } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(7));
    await actions.placeAutoTrack({ id: 'mine', title: 'Mine', artist: 'Listener', source: 'preview' });
    const before = state.playback.queue.map((entry) => entry.queueId);

    api.repairDjRoute.mockImplementationOnce(async (body: { route: Array<{ queue_id: string; route_kind: string }> }) => ({
      v: 1,
      items: body.route
        .filter((ref) => ref.route_kind !== 'user')
        .map((ref) => ({
          id: ref.queue_id, youtube_id: ref.queue_id, title: ref.queue_id, artist: 'Generated',
          source: 'preview', source_pool: 'related',
          recommendation_identity: `music:youtube:${ref.queue_id}`, recommendation_source: 'auto_mode',
          queue_id: ref.queue_id, route_kind: ref.route_kind,
        })),
      dropped: [], degraded: false,
    }));
    await actions.repairAutoRoute();

    expect(state.playback.queue.map((entry) => entry.queueId)).toEqual(before);
    expect(state.autoMode.activity?.key).toBe('autoMode.agent.repairSkipped');
  });

  it('never asks a repair to touch what is already playing', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 5 }, (_, index) => `route-${index}`)));
    const { actions, state, api } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(6));
    const playing = state.playback.queue[0];

    await actions.repairAutoRoute();

    const posted = api.repairDjRoute.mock.calls[0][0];
    expect(posted.seed.youtube_id ?? posted.seed.track_id).toBe('yt-current');
    expect(posted.route.some((ref: { queue_id: string }) => ref.queue_id === playing.queueId)).toBe(false);
    expect(state.playback.queue[0].queueId).toBe(playing.queueId);
  });

  it('ignores a second press while a repair is in flight', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 5 }, (_, index) => `route-${index}`)));
    const gate = deferred<unknown>();
    const repairDjRoute = vi.fn().mockReturnValue(gate.promise);
    const { actions, state } = await loadStore({ planDjQueue, repairDjRoute });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(6));

    const pending = actions.repairAutoRoute();
    expect(state.autoMode.repairing).toBe(true);
    await actions.repairAutoRoute();
    expect(repairDjRoute).toHaveBeenCalledTimes(1);

    gate.resolve({ v: 1, items: [], dropped: [], degraded: false });
    await pending;
    expect(state.autoMode.repairing).toBe(false);
  });

  it('undoes a repair back to the route and plan it replaced', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(Array.from({ length: 5 }, (_, index) => `route-${index}`)));
    const { actions, state, toastAction } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(6));
    const before = state.playback.queue.map((entry) => entry.queueId);
    const plan = { ...state.autoMode.plan };

    await actions.repairAutoRoute();
    toastAction.mock.calls.at(-1)![2]();

    expect(state.playback.queue.map((entry) => entry.queueId)).toEqual(before);
    expect(state.autoMode.plan).toEqual(plan);
  });

  it('has nothing to re-seam when the route is a single song', async () => {
    const planDjQueue = vi.fn().mockResolvedValue(autoPlan(['route-0']));
    const { actions, state, api } = await loadStore({ planDjQueue });
    actions.playFrom([{ id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' }], 0);
    actions.enterAutoMode();
    await vi.waitFor(() => expect(state.playback.queue.length).toBe(2));

    await actions.repairAutoRoute();
    expect(api.repairDjRoute).not.toHaveBeenCalled();
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
    expect(audioService.load).toHaveBeenCalledWith('/preview/seed2', 1);
    expect(state.playback.radioMode).toBe(true);
    expect(state.playback.radioSeedId).toBe('seed2');
    expect(state.playback.queue.map((t) => t.id)).toEqual(['seed2', 'mix02']);
  });

  it('refills Radio continuously as its generated runway is consumed', async () => {
    let batch = 0;
    const planMusicQueue = vi.fn(async (body: {
      intent: 'radio';
      profile: 'balanced';
    }) => {
      batch += 1;
      return {
        v: 1,
        plan_id: `radio-${batch}`,
        intent: body.intent,
        profile: body.profile,
        seed_identity: seed.id,
        degraded: false,
        generated_at: batch,
        pool_counts: { local: 0, related: 8, discovery: 0 },
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `batch-${batch}-${index}`,
          youtube_id: `batch-${batch}-${index}`,
          title: `Batch ${batch} Track ${index}`,
          artist: `Artist ${index}`,
          source: 'preview',
          source_pool: 'related',
          recommendation_identity: `music:youtube:batch-${batch}-${index}`,
          recommendation_source: 'radio',
        })),
      };
    });
    const { actions, state } = await loadStore({ planMusicQueue });
    actions.playFrom([seed], 0);
    await actions.startRadio(seed);
    expect(planMusicQueue).toHaveBeenCalledTimes(1);

    actions.jumpTo(6);
    await vi.waitFor(() => expect(planMusicQueue).toHaveBeenCalledTimes(2));

    expect(state.playback.radioMode).toBe(true);
    expect(state.playback.queue.filter((entry) => entry.queueSource === 'radio')).toHaveLength(17);
    actions.stopRadio();
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
    await actions.setAutoplayEnabled(false);
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
    // Browsable exactly like a file, which is the point of saving it. Files
    // last, because `sortTracks` reverses this list for "recent" and a reversed
    // concatenation swaps the blocks — see the memo's own note.
    expect(musicLibrary().map((t) => t.id)).toEqual(['dQw4w9WgXcQ', 't1']);

    // The download lands: the same song, now as its file — listed once, not
    // twice. No streaming rows left, so the files keep the engine's order.
    await actions.syncLibrary();
    expect(musicLibrary().map((t) => t.id)).toEqual(['t1', 'hash9f2a']);
  });

  it('puts a finished download at the top of "recent", not under every old save', async () => {
    // The bug this pins: with the blocks the other way round, every song ever
    // saved and never downloaded sat above every file. In the library it was
    // found in that was 72 saves, so a track downloaded a minute earlier opened
    // at position 73 and read as missing.
    const older = { id: 'old-file', title: 'Downloaded days ago', artist: 'A' };
    const justDownloaded = { id: 'new-file', title: 'Downloaded a minute ago', artist: 'B' };
    const { actions, musicLibrary } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({
        // The engine appends, so the newest file is last.
        tracks: [older, justDownloaded],
        playlists: {},
        settings: {},
        podcast_subscriptions: [],
      }),
      getSaved: vi.fn().mockResolvedValue([
        { keys: ['yt:aaaaaaaaaaa'], title: 'Saved weeks ago', artist: 'C' },
        { keys: ['yt:bbbbbbbbbbb'], title: 'Saved weeks ago too', artist: 'D' },
      ]),
    });

    await actions.syncLibrary();

    const { sortTracks } = await import('../lib/libraryView');
    const shown = sortTracks(musicLibrary(), 'recent', new Set()).map((t) => t.id);

    expect(shown[0]).toBe('new-file');
    expect(shown.slice(0, 2)).toEqual(['new-file', 'old-file']);
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

describe('the end of a track', () => {
  /** A store with the media listeners bound, one track playing, and the deck
   * reporting whatever the test needs it to. */
  async function playing(queue = [t1, t2]) {
    const store = await loadStore();
    store.initStore();
    store.actions.playFrom(queue, 0);
    return { ...store, deck: store.deck as unknown as { duration: number; currentTime: number } };
  }

  it('cues the next track even in shuffle', async () => {
    // The old guard here read an arrangement the player stopped using: shuffle
    // is written into the queue order itself, so `next` is knowable. Refusing to
    // cue it sent every track change back to the network — and a locked iPhone
    // freezes the page the moment nothing is sounding, so that request never
    // returns.
    const { actions, state, audioService, deck, fireDeckEvent } = await playing();
    actions.toggleShuffle();
    expect(state.playback.shuffle).toBe(true);
    audioService.stage.mockClear();
    audioService.clearStaged.mockClear();

    actions.playFrom([t1, t2], 0);
    (deck as unknown as { currentTime: number }).currentTime = 130;
    fireDeckEvent('timeupdate');
    await flush();

    expect(audioService.clearStaged).not.toHaveBeenCalled();
    expect(audioService.stage).toHaveBeenCalledWith(
      `/stream/${state.playback.queue[1].id}`,
      expect.any(Number),
    );
  });

  it('cues the first entry when repeat-all is about to wrap', async () => {
    const { actions, state, audioService, deck, fireDeckEvent } = await playing([t1, t2]);
    actions.cycleRepeat();
    while (state.playback.repeat !== 'all') actions.cycleRepeat();
    actions.next();
    expect(state.playback.index).toBe(1);
    audioService.stage.mockClear();

    deck.currentTime = 130;
    fireDeckEvent('timeupdate');
    await flush();

    // Whatever is cued has to be what `next` will actually play at the wrap.
    expect(audioService.stage).toHaveBeenCalledWith('/stream/t1', expect.any(Number));
  });

  it('tells the OS it is playing every time the track changes', async () => {
    // CarPlay showed each new track sitting paused while it was audibly
    // playing, and stayed wrong until the phone was unlocked. `playbackState`
    // was published only from the decks' `play` event, which is filtered to
    // whichever deck owns playback — and a DJ blend starts the incoming deck
    // before handing it ownership, so that event was discarded.
    const controls = stubMediaSession();
    const { actions, deck, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    expect(controls.mediaSession.playbackState).toBe('playing');

    actions.pausePlayback();
    (deck as unknown as { paused: boolean }).paused = true;
    fireDeckEvent('pause');
    expect(controls.mediaSession.playbackState).toBe('paused');

    // The next track is published as playing on the metadata change itself,
    // without waiting for a `play` event that a DJ blend never delivers to the
    // deck the store is listening to.
    actions.next();
    expect(controls.mediaSession.playbackState).toBe('playing');
  });

  it('answers the OS play button with play, never a toggle', async () => {
    // After a spell frozen in a pocket the store's `isPlaying` is whatever it
    // was when the page stopped running. A lock screen or a steering wheel says
    // which action it wants; answering `play` with a toggle pauses the music the
    // listener just asked to hear.
    const controls = stubMediaSession();
    const { actions, state, audioService } = await playing();
    audioService.resume.mockClear();
    actions.pausePlayback();
    expect(state.playback.isPlaying).toBe(false);
    // Stale, the way a frozen page leaves it.
    state.playback.isPlaying = true;

    controls.press('play');
    expect(audioService.resume).toHaveBeenCalled();
    expect(audioService.pause).not.toHaveBeenCalledTimes(2);
  });

  it('recovers a stream that was cut instead of skipping the rest of the song', async () => {
    const { state, deck, fireDeckEvent, audioService } = await playing();

    // The proxied stream ended at 1:12 of a 3:00 track: that is a cut
    // connection, not a song that finished.
    deck.currentTime = 72;
    fireDeckEvent('ended');

    expect(audioService.recover).toHaveBeenCalledWith('/stream/t1', 72, 1);
    expect(state.playback.currentTrack?.id).toBe('t1');
    expect(state.playback.phase).toBe('recovering');
  });

  it('leaves the transport reading complete, never frozen half way', async () => {
    const { state, deck, fireDeckEvent } = await playing([t1]);

    // The page was frozen with the screen off, so the store's own clock stopped
    // at 1:30 while the music played on to the end.
    state.playback.currentTime = 90;
    deck.currentTime = 180;
    fireDeckEvent('ended');

    expect(state.playback.currentTime).toBe(180);
  });

  it('runs out of music as starved, not paused, so something can resume it', async () => {
    const { state, deck, fireDeckEvent } = await playing([t1]);

    deck.currentTime = 180;
    fireDeckEvent('ended');
    await Promise.resolve();

    // `paused` is a decision the listener made and nothing looks at it again.
    // This is a promise still owed to them.
    expect(state.playback.phase).toBe('starved');
    expect(state.playback.isPlaying).toBe(false);
  });

  it('advances immediately when the queue still has a successor', async () => {
    const { state, deck, fireDeckEvent } = await playing();

    deck.currentTime = 180;
    fireDeckEvent('ended');

    expect(state.playback.currentTrack?.id).toBe('t2');
    expect(state.playback.index).toBe(1);
  });
});

describe('library refresh coalescing', () => {
  // Downloads finish one per track, and each completion used to refetch the
  // whole library — replacing `state.library` and rebuilding every derived
  // list — on the device that is also decoding audio.

  it('collapses a burst of background requests into one refresh', async () => {
    vi.useFakeTimers();
    try {
      const { actions, api } = await loadStore();
      await actions.syncLibrary();
      const before = api.getLibrary.mock.calls.length;

      for (let i = 0; i < 12; i += 1) actions.syncLibrarySoon();
      await vi.advanceTimersByTimeAsync(2000);

      expect(api.getLibrary.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still refreshes directly when the user asked for it', async () => {
    const { actions, api } = await loadStore();
    const before = api.getLibrary.mock.calls.length;

    await actions.syncLibrary();

    expect(api.getLibrary.mock.calls.length).toBe(before + 1);
  });
});

describe('download queue writes', () => {
  it('patches the retried row without disturbing its neighbours', async () => {
    const { actions, state, api } = await loadStore({
      getDownloadQueue: vi.fn().mockResolvedValue({
        queue: [
          { id: 'a', status: 'failed', error: 'boom' },
          { id: 'b', status: 'downloading', progress_percent: 40 },
        ],
        is_processing: true,
      }),
      retryDownload: vi.fn().mockResolvedValue({ status: 'ok' }),
    });
    await actions.loadDownloads();
    const untouched = state.downloads.queue[1];

    actions.retryDownload('a');

    expect(state.downloads.queue[0].status).toBe('pending');
    expect(state.downloads.queue[0].error).toBeUndefined();
    // The other row is the very same object: nothing rebuilt the array.
    expect(state.downloads.queue[1]).toBe(untouched);
    expect(api.retryDownload).toHaveBeenCalledWith('a');
  });
});

describe('cross-device sessions', () => {
  const current: Track = { id: 'current', title: 'Current', artist: 'Artist', youtube_id: 'yt-current' };
  const seed: Track = { id: 'seed', title: 'Seed', artist: 'Björk' };
  const related = Array.from({ length: 10 }, (_, i) => ({
    id: `auto-${i}`,
    title: `Auto ${i}`,
    channel: `Artist ${i}`,
  }));

  /** Everything one device publishes about an Auto session it is running. */
  async function publishedAutoSession() {
    const { actions, state, api } = await loadStore({
      relatedYouTube: vi.fn().mockResolvedValue(related),
      searchYouTube: vi.fn().mockResolvedValue([{ id: 'yt-current' }]),
    });
    actions.playFrom([current], 0);
    actions.enterAutoMode();
    actions.addAutoSource([seed], 'Björk');
    actions.setAutoDirection({ energy: 2, prompt: 'darker' });
    await vi.waitFor(() => expect(state.playback.queue.length).toBeGreaterThan(1));

    actions.seek(42);
    await flush();
    const body = api.putPlaybackState.mock.calls.at(-1)![0] as Record<string, any>;
    return { body, queue: state.playback.queue.map((entry) => entry.id) };
  }

  /** The same state as it reaches a second device: another device, seen now. */
  const asRemote = (body: Record<string, any>) => ({
    ...body,
    device_id: 'dev2',
    device_name: 'Phone',
    updated_at: Date.now() / 1000,
  });

  it('publishes the whole Auto workspace alongside the song', async () => {
    const { body } = await publishedAutoSession();

    expect(body.session.mode).toBe('auto');
    expect(body.session.auto.sources.map((source: { label: string }) => source.label)).toEqual(['Björk']);
    expect(body.session.auto.direction).toMatchObject({ energy: 2, prompt: 'darker' });
    expect(body.session.queue.length).toBeGreaterThan(1);
    expect(body.session.queue[body.session.index].id).toBe('current');
  });

  it('leaves the session out of a ping that only carries a new position', async () => {
    const { actions, api, state } = await loadStore();
    actions.playFrom([t1, t2], 0);
    actions.seek(10);
    await flush();

    actions.seek(20);
    await flush();

    const [first, second] = api.putPlaybackState.mock.calls.slice(-2).map(([body]: [any]) => body);
    expect(first.session ?? second.session).toBeDefined();
    expect('session' in second).toBe(false);
    // …until the session itself changes.
    actions.enqueue(t2);
    actions.seek(30);
    await flush();
    expect(api.putPlaybackState.mock.calls.at(-1)![0].session.queue).toHaveLength(3);
    expect(state.playback.queue).toHaveLength(3);
  });

  it('says the session is over rather than resumable once nothing is playing', async () => {
    const { actions, api } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({ tracks: [t1], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      deleteTrack: vi.fn().mockResolvedValue({ status: 'ok' }),
    });
    await actions.syncLibrary();
    actions.playFrom([t1], 0);

    await actions.deleteTrack('t1');

    expect(api.putPlaybackState).toHaveBeenCalledWith(
      expect.objectContaining({ track_id: null, session: null }),
      expect.anything(),
    );
  });

  it('resumes an Auto session as an Auto session, route and sources included', async () => {
    const { body, queue } = await publishedAutoSession();
    const { actions, state, resumeState, audioService } = await loadStore({
      getPlaybackState: vi.fn().mockResolvedValue(asRemote(body)),
      relatedYouTube: vi.fn().mockResolvedValue(related),
    });

    await actions.syncLibrary();
    await actions.checkResume();
    expect(resumeState()?.device_name).toBe('Phone');

    actions.resumeHere();

    expect(state.autoMode.active).toBe(true);
    expect(state.autoMode.sources.map((source) => source.label)).toEqual(['Björk']);
    expect(state.autoMode.direction).toMatchObject({ energy: 2, prompt: 'darker' });
    expect(state.playback.queue.map((entry) => entry.id)).toEqual(queue);
    expect(state.playback.currentTrack?.id).toBe('current');
    expect(state.playback.index).toBe(0);
    expect(state.playback.isPlaying).toBe(true);
    await vi.waitFor(() => expect(audioService.seek).toHaveBeenCalledWith(42));
  });

  it('puts this device\'s own session back paused, queue and all, after a reload', async () => {
    const { body, queue } = await publishedAutoSession();
    const { actions, state, resumeState, audioService } = await loadStore({
      getPlaybackState: vi.fn().mockResolvedValue({ ...body, updated_at: Date.now() / 1000 }),
    });

    await actions.syncLibrary();
    await actions.checkResume();

    expect(resumeState()).toBeNull();
    expect(state.autoMode.active).toBe(true);
    expect(state.playback.queue.map((entry) => entry.id)).toEqual(queue);
    expect(state.playback.isPlaying).toBe(false);
    expect(state.playback.currentTime).toBe(42);
    expect(audioService.prime).toHaveBeenCalledWith('/stream/current', 42, 1);
  });

  it('resumes the single song a session-less state names, as it always did', async () => {
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
    expect(resumeState()?.track_id).toBe('t1');

    actions.resumeHere();

    expect(state.playback.currentTrack?.id).toBe('t1');
    expect(state.playback.queue.map((entry) => entry.id)).toEqual(['t1']);
    expect(state.autoMode.active).toBe(false);
  });

  it('ignores a session that has moved on from the song the state names', async () => {
    const { body } = await publishedAutoSession();
    const { actions, state } = await loadStore({
      getLibrary: vi.fn().mockResolvedValue({ tracks: [t1], playlists: {}, settings: {}, podcast_subscriptions: [] }),
      getPlaybackState: vi.fn().mockResolvedValue(asRemote({ ...body, track_id: 't1', track: t1 })),
    });

    await actions.syncLibrary();
    await actions.checkResume();
    actions.resumeHere();

    expect(state.autoMode.active).toBe(false);
    expect(state.playback.queue.map((entry) => entry.id)).toEqual(['t1']);
  });

  it('takes the whole session over when another device hands playback here', async () => {
    const { body, queue } = await publishedAutoSession();
    const { initStore, state, fireSocketEvent } = await loadStore({
      relatedYouTube: vi.fn().mockResolvedValue(related),
    });
    initStore();
    await flush();

    fireSocketEvent('playback_start_requested', {
      track: body.track,
      state: { ...body, device_id: 'dev1', position_sec: 42, is_playing: true },
    });

    expect(state.autoMode.active).toBe(true);
    expect(state.playback.queue.map((entry) => entry.id)).toEqual(queue);
    expect(state.playback.currentTrack?.id).toBe('current');
    expect(state.playback.isPlaying).toBe(true);
  });

  it('sends a session too big for a keepalive request as an ordinary one', async () => {
    const { initStore, actions, api } = await loadStore();
    initStore();
    await flush();

    actions.playFrom([t1, t2], 0);
    await flush();
    api.putPlaybackState.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(api.putPlaybackState.mock.calls.at(-1)![1]).toEqual({ keepalive: true });

    // A route long enough to pass the 64 KB a keepalive request may weigh: the
    // position report has to survive even when the session cannot ride with it.
    actions.playFrom(
      Array.from({ length: 40 }, (_, i) => ({ id: `fat-${i}`, title: 'x'.repeat(1500), artist: 'Artist' })),
      0,
    );
    await flush();
    api.putPlaybackState.mockClear();
    window.dispatchEvent(new Event('pagehide'));

    const [body, opts] = api.putPlaybackState.mock.calls.at(-1)!;
    expect(opts).toEqual({ keepalive: false });
    expect(body.session.queue.length).toBeGreaterThan(1);
  });

  it('keeps asking for a session while a handoff is still publishing one', async () => {
    vi.useFakeTimers();
    try {
      window.location.hash = '#/live?handoff=live';
      const getPlaybackState = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({
          device_id: 'dev2',
          device_name: 'Phone',
          track_id: 't1',
          track: t1,
          position_sec: 5,
          is_playing: true,
          updated_at: Date.now() / 1000,
        });
      const { initStore, resumeState } = await loadStore({ getPlaybackState });

      initStore();
      await vi.advanceTimersByTimeAsync(6000);

      expect(getPlaybackState.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(resumeState()?.device_name).toBe('Phone');
    } finally {
      window.location.hash = '';
      vi.useRealTimers();
    }
  });

  it('stops asking after a handful of tries on an ordinary boot', async () => {
    vi.useFakeTimers();
    try {
      const getPlaybackState = vi.fn().mockResolvedValue(undefined);
      const { initStore } = await loadStore({ getPlaybackState });

      initStore();
      await vi.advanceTimersByTimeAsync(14000);

      expect(getPlaybackState).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('playback delivery telemetry', () => {
  /** Every play-timing row of one phase, newest last. */
  const rowsFor = (api: Record<string, any>, phase: string) =>
    (api.sendPlayTiming.mock.calls as unknown[][])
      .map(([row]) => row as { phase: string; segments: Record<string, number> })
      .filter((row) => row.phase === phase);

  it('does not report the opening buffer as a stall', async () => {
    // It was reported as one, on `ui_click_to_playing`, which fires at the instant
    // of first sound — so the only spell it could ever contain was the wait the
    // listener had just sat through, and `click_to_playing_ms` beside it already
    // described that. It read 1 on 56 of 58 plays before the delivery change and 8
    // of 9 after: a metric that cannot move measures nothing.
    const { actions, api, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    fireDeckEvent('waiting');
    fireDeckEvent('playing');
    await flush();

    const [start] = rowsFor(api, 'ui_click_to_playing');
    expect(start.segments.click_to_playing_ms).toBeGreaterThanOrEqual(0);
    expect(start.segments).not.toHaveProperty('stall_count');
    expect(start.segments).toHaveProperty('startup_stall_ms');
  });

  it('counts audio that stopped after it started, once the play is over', async () => {
    const { actions, api, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    fireDeckEvent('playing');
    // The stream died mid-song and came back. This is the event the old counter
    // was supposed to be catching and never could.
    fireDeckEvent('waiting');
    fireDeckEvent('playing');
    fireDeckEvent('ended');
    await flush();

    const [delivery] = rowsFor(api, 'ui_play_delivery');
    expect(delivery.segments.rebuffer_count).toBe(1);
    expect(delivery.segments.seek_rebuffer_count).toBe(0);
  });

  it('does not blame delivery for audio that stopped because the listener seeked', async () => {
    // Dragging the scrubber into un-buffered audio stops the sound, and the
    // element reports it exactly as it reports a stream that died. Summed
    // together, a day of heavy scrubbing reads as a delivery regression.
    const { actions, api, initStore, fireDeckEvent } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    fireDeckEvent('playing');
    fireDeckEvent('seeking');
    fireDeckEvent('waiting');
    fireDeckEvent('playing');
    fireDeckEvent('ended');
    await flush();

    const [delivery] = rowsFor(api, 'ui_play_delivery');
    expect(delivery.segments.rebuffer_count).toBe(0);
    expect(delivery.segments.seek_rebuffer_count).toBe(1);
  });

  it('reports a play that never made a sound as an attempt, not as a delivery', async () => {
    // `ui_play_delivery` answers "did the music keep playing". A track that never
    // played has no answer to give, and `ui_attempt_cancelled` already covers it.
    const { actions, api, initStore } = await loadStore();
    initStore();

    actions.playFrom([t1, t2], 0);
    await flush();
    actions.next();
    await flush();

    expect(rowsFor(api, 'ui_play_delivery')).toHaveLength(0);
    expect(rowsFor(api, 'ui_attempt_cancelled').length).toBeGreaterThan(0);
  });
});
