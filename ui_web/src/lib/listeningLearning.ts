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
    this.finish(track, duration, false);
  }

  skip(track: Track | null, duration = track?.duration ?? 0): void {
    this.finish(track, duration, true);
  }

  private finish(track: Track | null, duration: number, skipped: boolean): void {
    if (!track || this.outcomeEmitted || track.id !== this.trackId || isPodcastTrack(track)) return;
    const total = Number(duration || 0);
    const gen = ['auto_mode', 'autoplay', 'radio'].includes(track.recommendation?.source ?? '');
    const sec = this.listenedSeconds;
    const ok = skipped
      ? (gen || sec >= 4) && sec < Math.min(gen ? 60 : 25, Math.max(12, total * (gen ? 0.3 : 0.25)))
      : sec >= (gen ? Math.min(60, Math.max(12, total * 0.6)) : total > 0 ? Math.min(180, Math.max(30, total * 0.7)) : this.thresholdSeconds);
    if (!ok) return;
    this.outcomeEmitted = true;
    this.emit(`music_${gen ? 'generated' : 'play'}_${skipped ? 'skipped_early' : 'completed'}`, this.payload(track, total));
  }

  private deezerId(track: Track): string | undefined {
    const direct = (track as { deezer_id?: string }).deezer_id;
    if (direct && /^\d+$/.test(direct)) return direct;
    for (const key of [track.id, track.canonical_identity, track.recommendation?.identity, ...(track.originKeys ?? [])]) {
      const s = key?.trim() ?? '';
      const id = s.startsWith('music:deezer:') ? s.slice(13) : s.startsWith('deezer:') ? s.slice(7) : '';
      if (id && /^\d+$/.test(id)) return id;
    }
    return undefined;
  }

  private payload(track: Track, durationSec = Number(track.duration || 0)): Record<string, unknown> {
    const podcast = isPodcastTrack(track);
    const queueSource = (track as { queueSource?: string }).queueSource;
    const base = {
      title: track.title,
      artist: track.artist,
      album: track.album,
      source: track.recommendation?.source || queueSource || (track.source === 'preview' ? 'preview' : 'library'),
      play_session_id: this.playSessionId || undefined,
      listened_sec: Math.round(this.listenedSeconds),
      duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
    };
    return podcast
      ? {
          ...base,
          media_type: 'podcast_episode',
          podcast_feed_id: track.podcast_feed_id,
          podcast_episode_id: track.podcast_episode_guid,
          podcast_show_title: track.artist,
        }
      : {
          ...base,
          media_type: 'music_track',
          track_id: track.id,
          youtube_id: track.youtube_id || (track.source === 'preview' ? track.id : undefined),
          deezer_id: this.deezerId(track),
          deezer_artist_id: track.deezer_artist_id || undefined,
        };
  }
}
