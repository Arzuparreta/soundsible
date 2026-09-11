import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramMediaSession } from './mediaSession';
import type { ProgramPlaybackSnapshot } from './audio';
import type { Track } from '../types/music';
import { playbackDiagnosticExport, startPlaybackDiagnostics, stopPlaybackDiagnostics } from './playbackDiagnostics';

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
  it('gives system controls a bounded square without claiming an invented resolution', () => {
    const session = controls();
    new ProgramMediaSession().sync(track, snapshot(true), 'track');
    const artwork = session.metadata!.artwork[0];
    const url = new URL(artwork.src, 'http://localhost');
    expect(url.searchParams.get('size')).toBe('640');
    expect(url.searchParams.get('fit')).toBe('square');
    expect(artwork.sizes).toBeUndefined();
  });

  it('keeps external preview artwork URLs intact', () => {
    const session = controls();
    new ProgramMediaSession().sync({ ...track, source: 'preview', cover: 'https://example.com/art.jpg' }, snapshot(true), 'track');
    expect(session.metadata!.artwork[0].src).toBe('https://example.com/art.jpg');
  });
  it('records the previous declaration before overwriting it with the expected state', () => {
    const session = controls();
    session.playbackState = 'paused';
    startPlaybackDiagnostics({ userId: 'user', deviceId: 'device', platform: 'test', displayMode: 'browser' });
    try {
      new ProgramMediaSession().sync(track, snapshot(true), 'handoff_settled', true);
      const rows = JSON.parse(playbackDiagnosticExport()).events;
      expect(rows.find((row: { event: string }) => row.event === 'media_session.before_sync').declaredState).toBe('paused');
      expect(rows.find((row: { event: string }) => row.event === 'media_session.after_sync').declaredState).toBe('playing');
    } finally { stopPlaybackDiagnostics(); }
  });

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
