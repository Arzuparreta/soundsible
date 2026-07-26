import type { Track } from '../types/music';
import { isPodcastTrack } from './track';

/** Counts real, forward playback time without treating seeks as listening. */
export class ListeningLearning {
  private trackId = '';
  private lastPosition: number | null = null;
  private listenedSeconds = 0;
  private emitted = false;

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
      return;
    }
    if (!track || !Number.isFinite(position)) return;

    const previous = this.lastPosition;
    this.lastPosition = position;
    if (!playing || previous == null || this.emitted) return;
    const delta = position - previous;
    // timeupdate cadence is normally <1s. Larger jumps are seeks or a
    // suspended tab catching up and must not manufacture listening.
    if (delta <= 0 || delta > 3) return;
    this.listenedSeconds += delta;
    if (this.listenedSeconds < this.thresholdSeconds) return;

    this.emitted = true;
    const podcast = isPodcastTrack(track);
    this.emit(podcast ? 'podcast_episode_played_30s' : 'music_played_30s', {
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
    });
  }
}
