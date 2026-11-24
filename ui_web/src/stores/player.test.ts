import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PODCAST_SKIP_SECONDS } from '../lib/track';

const harness = vi.hoisted(() => ({
  actions: {
    next: vi.fn(),
    autoSkip: vi.fn(),
    seekBy: vi.fn(),
  },
  setState: undefined as undefined | ((...args: unknown[]) => void),
}));

vi.mock('./index', async () => {
  const { createStore } = await vi.importActual<typeof import('solid-js/store')>('solid-js/store');
  const [state, setState] = createStore({
    playback: {
      currentTrack: { id: 'track-1', title: 'Song', artist: 'Artist' } as {
        id: string;
        title: string;
        artist: string;
        podcast_episode_guid?: string;
        media_kind?: 'track' | 'podcast_episode';
      } | null,
      volume: 0.8,
      muted: false,
    },
    autoMode: { active: false },
    device: { device_name: 'Web' },
  });
  harness.setState = setState as unknown as (...args: unknown[]) => void;
  return {
    actions: harness.actions,
    state,
  };
});

vi.mock('./remoteLink', () => ({ remoteStore: () => null }));

import { advancePlayback, isCurrentTrackPodcast, isPlaybackSilent } from './player';

beforeEach(() => {
  harness.setState?.('playback', {
    currentTrack: { id: 'track-1', title: 'Song', artist: 'Artist' },
    volume: 0.8,
    muted: false,
  });
  harness.setState?.('autoMode', 'active', false);
  vi.clearAllMocks();
});

describe('stores/player helpers', () => {
  it('detects silence from explicit mute or zero volume', () => {
    expect(isPlaybackSilent()).toBe(false);

    harness.setState?.('playback', 'muted', true);
    expect(isPlaybackSilent()).toBe(true);

    harness.setState?.('playback', 'muted', false);
    harness.setState?.('playback', 'volume', 0);
    expect(isPlaybackSilent()).toBe(true);
  });

  it('recognizes podcast tracks by guid or media_kind', () => {
    expect(isCurrentTrackPodcast()).toBe(false);

    harness.setState?.('playback', 'currentTrack', null);
    expect(isCurrentTrackPodcast()).toBe(false);

    harness.setState?.('playback', 'currentTrack', {
      id: 'ep-guid',
      title: 'Episode',
      artist: 'Show',
      podcast_episode_guid: 'guid-1',
    });
    expect(isCurrentTrackPodcast()).toBe(true);

    harness.setState?.('playback', 'currentTrack', {
      id: 'ep-kind',
      title: 'Episode',
      artist: 'Show',
      media_kind: 'podcast_episode',
    });
    expect(isCurrentTrackPodcast()).toBe(true);
  });

  it('routes advancePlayback across music, Auto Mode and podcasts', () => {
    advancePlayback();
    expect(harness.actions.next).toHaveBeenCalledOnce();

    harness.setState?.('autoMode', 'active', true);
    advancePlayback();
    expect(harness.actions.autoSkip).toHaveBeenCalledOnce();

    harness.setState?.('playback', 'currentTrack', {
      id: 'ep-1',
      title: 'Episode',
      artist: 'Show',
      media_kind: 'podcast_episode',
    });
    advancePlayback();
    expect(harness.actions.seekBy).toHaveBeenCalledWith(PODCAST_SKIP_SECONDS);
    expect(harness.actions.next).toHaveBeenCalledOnce();
    expect(harness.actions.autoSkip).toHaveBeenCalledOnce();
  });
});
