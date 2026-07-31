import type { Track } from '../types/music';
import { isPodcastTrack } from './track';

/** Counts real, forward playback time without treating seeks as listening. */
export class ListeningLearning {
  private trackId = '';
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
    if (!track || this.outcomeEmitted || !this.isGenerated(track) || track.id !== this.trackId) return;
    const threshold = Math.min(60, Math.max(12, Number(duration || 0) * 0.6));
    if (this.listenedSeconds < threshold) return;
    this.outcomeEmitted = true;
    this.emit('music_generated_completed', this.payload(track));
  }

  skip(track: Track | null, duration = track?.duration ?? 0): void {
    if (!track || this.outcomeEmitted || !this.isGenerated(track) || track.id !== this.trackId) return;
    const earlyBoundary = Math.min(60, Math.max(12, Number(duration || 0) * 0.3));
    if (this.listenedSeconds >= earlyBoundary) return;
    this.outcomeEmitted = true;
    this.emit('music_generated_skipped_early', this.payload(track));
  }

  private isGenerated(track: Track): boolean {
    return ['auto_mode', 'autoplay', 'radio'].includes(track.recommendation?.source ?? '');
  }

  private payload(track: Track): Record<string, unknown> {
    const podcast = isPodcastTrack(track);
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
      source: track.recommendation?.source || (track.source === 'preview' ? 'preview' : 'library'),
    };
  }
}
