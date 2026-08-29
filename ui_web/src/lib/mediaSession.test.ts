import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramMediaSession } from './mediaSession';
import type { ProgramPlaybackSnapshot } from './audio';
import type { Track } from '../types/music';

const track: Track = { id: 'one', title: 'One', artist: 'Artist', duration: 180 };

function snapshot(playing: boolean): ProgramPlaybackSnapshot {
  return {
    outputMode: 'carrier',
    playing,
    sourcePlaying: playing,
    carrierPlaying: playing,
    position: 12,
    duration: 180,
    playbackRate: 1,
    ended: false,
    readyState: 4,
    networkState: 1,
    mediaErrorCode: 0,
    hasSource: true,
    bufferedEnd: 90,
    activeIndex: 0,
    mixPhase: 'idle',
    dominant: false,
    contextState: 'running',
  };
}

function controls() {
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: 'none' as MediaSessionPlaybackState,
    setPositionState: vi.fn(),
    setActionHandler: vi.fn(),
  };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  vi.stubGlobal('MediaMetadata', class { constructor(init: object) { Object.assign(this, init); } });
  return session;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('programme Media Session projection', () => {
  it('publishes metadata, position and playback state from one snapshot', () => {
    const session = controls();
    const media = new ProgramMediaSession();

    media.sync(track, snapshot(true), 'track');

    expect(session.metadata).toMatchObject({ title: 'One', artist: 'Artist' });
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 180, position: 12, playbackRate: 1 });
    expect(session.playbackState).toBe('playing');

    media.sync(track, snapshot(false), 'paused');
    expect(session.playbackState).toBe('paused');
  });

  it('refreshes metadata at a DJ ownership boundary without inventing playback', () => {
    const session = controls();
    const media = new ProgramMediaSession();
    const report = vi.fn();
    media.setReporter(report);

    media.sync(track, snapshot(false), 'handoff_dominant', true);

    expect(session.playbackState).toBe('paused');
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: 'handoff_dominant',
      expectedState: 'paused',
      declaredState: 'paused',
      revision: 1,
    }));
  });
});
