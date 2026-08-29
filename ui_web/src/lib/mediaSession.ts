import { coverUrl } from './media';
import type { ProgramPlaybackSnapshot } from './audio';
import type { Track } from '../types/music';

export type MediaSessionSyncReason =
  | 'track'
  | 'playing'
  | 'paused'
  | 'position'
  | 'handoff_dominant'
  | 'handoff_settled'
  | 'visibility_resume'
  | 'output_change'
  | 'source_anomaly'
  | 'clear';

export interface MediaSessionSyncEvent {
  reason: MediaSessionSyncReason;
  expectedState: MediaSessionPlaybackState;
  declaredState: MediaSessionPlaybackState;
  revision: number;
  outputMode: ProgramPlaybackSnapshot['outputMode'];
  carrierPlaying: boolean;
  sourcePlaying: boolean;
}

export interface MediaSessionActions {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(position: number): void;
  seekBackward(offset?: number): void;
  seekForward(offset?: number): void;
}

/** One atomic projection of Soundsible's programme into the platform session. */
export class ProgramMediaSession {
  private trackKey = '';
  private revision = 0;
  private reporter: ((event: MediaSessionSyncEvent) => void) | null = null;

  setReporter(reporter: ((event: MediaSessionSyncEvent) => void) | null): void {
    this.reporter = reporter;
  }

  installActions(actions: MediaSessionActions): void {
    if (!hasMediaSession()) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', actions.play);
    session.setActionHandler('pause', actions.pause);
    session.setActionHandler('nexttrack', actions.next);
    session.setActionHandler('previoustrack', actions.previous);
    session.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') actions.seekTo(details.seekTime);
    });
    setOptionalHandler(session, 'seekbackward', (details) => actions.seekBackward(details.seekOffset));
    setOptionalHandler(session, 'seekforward', (details) => actions.seekForward(details.seekOffset));
  }

  sync(
    track: Track | null,
    snapshot: ProgramPlaybackSnapshot,
    reason: MediaSessionSyncReason,
    forceMetadata = false,
  ): void {
    if (!hasMediaSession()) return;
    const session = navigator.mediaSession;
    if (!track) {
      if (this.trackKey || session.metadata) this.revision += 1;
      this.trackKey = '';
      clearPosition(session);
      session.metadata = null;
      session.playbackState = 'none';
      this.report(reason === 'clear' ? reason : 'clear', 'none', snapshot);
      return;
    }

    const nextKey = `${track.id}\u0000${track.title}\u0000${track.artist}\u0000${track.album ?? ''}`;
    if (forceMetadata || nextKey !== this.trackKey || !session.metadata) {
      this.trackKey = nextKey;
      this.revision += 1;
      const artwork = track.cover ?? coverUrl(track.id);
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : [],
      });
    }
    setPosition(session, snapshot);
    const expected: MediaSessionPlaybackState = snapshot.playing ? 'playing' : 'paused';
    session.playbackState = expected;
    this.report(reason, expected, snapshot);
  }

  private report(
    reason: MediaSessionSyncReason,
    expectedState: MediaSessionPlaybackState,
    snapshot: ProgramPlaybackSnapshot,
  ): void {
    if (!hasMediaSession()) return;
    this.reporter?.({
      reason,
      expectedState,
      declaredState: navigator.mediaSession.playbackState,
      revision: this.revision,
      outputMode: snapshot.outputMode,
      carrierPlaying: snapshot.carrierPlaying,
      sourcePlaying: snapshot.sourcePlaying,
    });
  }
}

function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function setPosition(session: MediaSession, snapshot: ProgramPlaybackSnapshot): void {
  if (typeof session.setPositionState !== 'function') return;
  try {
    if (!Number.isFinite(snapshot.duration) || snapshot.duration <= 0) {
      clearPosition(session);
      return;
    }
    session.setPositionState({
      duration: snapshot.duration,
      position: Math.min(Math.max(snapshot.position, 0), snapshot.duration),
      playbackRate: snapshot.playbackRate > 0 ? snapshot.playbackRate : 1,
    });
  } catch {
    /* Safari can reject while a source is between loads; the next event retries. */
  }
}

function clearPosition(session: MediaSession): void {
  try {
    session.setPositionState?.();
  } catch {
    /* optional platform surface */
  }
}

function setOptionalHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    /* unsupported action */
  }
}
