import type { Track } from '../types/music';
import { isPodcastTrack } from './track';

function newPlaySessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Counts real, forward playback time without treating seeks as listening. */
export class ListeningLearning {
  private trackId = '';
  private playSessionId = '';
  private lastPosition: number | null = null;
  private listenedSeconds = 0;
  private emitted = false;
  private outcomeEmitted = false;

  constructor(
    private readonly emit: (event: string, payload: Record<string, unknown>) => void,
    private readonly thresholdSeconds = 30,
  ) {}

  update(track: Track | null, position: number, playing: boolean): void {
    const nextId = track?.id ?? '';
    if (nextId !== this.trackId) {
      this.trackId = nextId;
      this.playSessionId = nextId ? newPlaySessionId() : '';
      this.lastPosition = Number.isFinite(position) ? position : null;
      this.listenedSeconds = 0;
      this.emitted = false;
      this.outcomeEmitted = false;
      return;
    }
    if (!track || !Number.isFinite(position)) return;

    const previous = this.lastPosition;
    this.lastPosition = position;
    if (!playing || previous == null) return;
    const delta = position - previous;
    // timeupdate cadence is normally <1s. Larger jumps are seeks or a
    // suspended tab catching up and must not manufacture listening.
    if (delta <= 0 || delta > 3) return;
    this.listenedSeconds += delta;
    if (this.emitted || this.listenedSeconds < this.thresholdSeconds) return;

    this.emitted = true;
    const podcast = isPodcastTrack(track);
    this.emit(podcast ? 'podcast_episode_played_30s' : 'music_played_30s', this.payload(track));
  }

  complete(track: Track | null, duration = track?.duration ?? 0): void {
    if (!track || this.outcomeEmitted || track.id !== this.trackId || isPodcastTrack(track)) return;
    const total = Number(duration || 0);
    if (this.isGenerated(track)) {
      const threshold = Math.min(60, Math.max(12, total * 0.6));
      if (this.listenedSeconds < threshold) return;
      this.outcomeEmitted = true;
      this.emit('music_generated_completed', this.payload(track, total));
      return;
    }
    const threshold = total > 0 ? Math.min(180, Math.max(30, total * 0.7)) : this.thresholdSeconds;
    if (this.listenedSeconds < threshold) return;
    this.outcomeEmitted = true;
    this.emit('music_play_completed', this.payload(track, total));
  }

  skip(track: Track | null, duration = track?.duration ?? 0): void {
    if (!track || this.outcomeEmitted || track.id !== this.trackId || isPodcastTrack(track)) return;
    const total = Number(duration || 0);
    if (this.isGenerated(track)) {
      const earlyBoundary = Math.min(60, Math.max(12, total * 0.3));
      if (this.listenedSeconds >= earlyBoundary) return;
      this.outcomeEmitted = true;
      this.emit('music_generated_skipped_early', this.payload(track, total));
      return;
    }
    const earlyBoundary = Math.min(25, Math.max(12, total * 0.25));
    if (this.listenedSeconds < 4 || this.listenedSeconds >= earlyBoundary) return;
    this.outcomeEmitted = true;
    this.emit('music_play_skipped_early', this.payload(track, total));
  }

  private isGenerated(track: Track): boolean {
    return ['auto_mode', 'autoplay', 'radio'].includes(track.recommendation?.source ?? '');
  }

  private payload(track: Track, durationSec = Number(track.duration || 0)): Record<string, unknown> {
    const podcast = isPodcastTrack(track);
    const queueSource = (track as { queueSource?: string }).queueSource;
    const rawSource = track.recommendation?.source || queueSource || (track.source === 'preview' ? 'preview' : 'library');
    return {
      media_type: podcast ? 'podcast_episode' : 'music_track',
      track_id: podcast ? undefined : track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      youtube_id: podcast ? undefined : track.youtube_id || (track.source === 'preview' ? track.id : undefined),
      podcast_feed_id: track.podcast_feed_id,
      podcast_episode_id: track.podcast_episode_guid,
      podcast_show_title: podcast ? track.artist : undefined,
      source: rawSource,
      play_session_id: this.playSessionId || undefined,
      listened_sec: Math.round(this.listenedSeconds),
      duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
    };
  }
}
