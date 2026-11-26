import type { Track } from '../types/music';
import { randomId } from './randomId';
import { isPodcastTrack } from './track';

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
      this.playSessionId = nextId ? randomId() : '';
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
    const generated = this.isGenerated(track);
    const threshold = generated
      ? Math.min(60, Math.max(12, total * 0.6))
      : total > 0 ? Math.min(180, Math.max(30, total * 0.7)) : this.thresholdSeconds;
    if (this.listenedSeconds < threshold) return;
    this.outcomeEmitted = true;
    this.emit(generated ? 'music_generated_completed' : 'music_play_completed', this.payload(track, total));
  }

  skip(track: Track | null, duration = track?.duration ?? 0): void {
    if (!track || this.outcomeEmitted || track.id !== this.trackId || isPodcastTrack(track)) return;
    const total = Number(duration || 0);
    const generated = this.isGenerated(track);
    const earlyBoundary = generated
      ? Math.min(60, Math.max(12, total * 0.3))
      : Math.min(25, Math.max(12, total * 0.25));
    if ((!generated && this.listenedSeconds < 4) || this.listenedSeconds >= earlyBoundary) return;
    this.outcomeEmitted = true;
    this.emit(generated ? 'music_generated_skipped_early' : 'music_play_skipped_early', this.payload(track, total));
  }

  private isGenerated(track: Track): boolean {
    return ['auto_mode', 'autoplay', 'radio'].includes(track.recommendation?.source ?? '');
  }

  private extractDeezerTrackId(track: Track): string | undefined {
    const direct = (track as { deezer_id?: string }).deezer_id;
    if (direct && /^\d+$/.test(direct)) return direct;
    const candidates = [
      track.id,
      track.canonical_identity ?? undefined,
      track.recommendation?.identity,
      ...(track.originKeys ?? []),
    ];
    for (const candidate of candidates) {
      const match = candidate ? /^(?:music:)?deezer:(\d+)$/.exec(candidate.trim()) : null;
      if (match?.[1]) return match[1];
    }
    return undefined;
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
      deezer_id: podcast ? undefined : this.extractDeezerTrackId(track),
      deezer_artist_id: podcast ? undefined : track.deezer_artist_id || undefined,
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
