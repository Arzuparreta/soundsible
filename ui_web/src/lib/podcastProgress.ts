import type { Track } from '../types/music';
import { isPodcastTrack } from './track';

interface Progress { position: number; completed: boolean; updated: number }
const MAX_EPISODES = 500;

/** Local to this station, browser and account. Enclosure identity also joins a
 * streamed episode to its downloaded copy; tokens and queue occurrences do not. */
export class PodcastProgress {
  private records: Record<string, Progress> = {};
  private storageKey = '';

  private select(userId: string | undefined): void {
    const key = `podcast-progress:${userId ?? 'anonymous'}`;
    if (key === this.storageKey) return;
    this.storageKey = key;
    this.records = {};
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [id, item] of Object.entries(raw).slice(-MAX_EPISODES)) {
        const row = item as Partial<Progress> | null;
        if (row && Number.isFinite(row.position) && Number(row.position) >= 0 && Number.isFinite(row.updated)) {
          this.records[id] = { position: Number(row.position), completed: row.completed === true, updated: Number(row.updated) };
        }
      }
    } catch { /* Storage unavailable: keep listening with in-memory progress. */ }
  }

  private identity(track: Track): string | null {
    if (!isPodcastTrack(track)) return null;
    return JSON.stringify(track.podcast_enclosure_url
      ? ['enclosure', track.podcast_enclosure_url]
      : ['episode', track.podcast_feed_id ?? track.artist, track.podcast_episode_guid ?? track.id]);
  }

  position(track: Track, userId: string | undefined): number {
    this.select(userId);
    const id = this.identity(track);
    const row = id ? this.records[id] : undefined;
    // Selecting a completed episode deliberately replays it from the beginning.
    return row && !row.completed ? row.position : 0;
  }

  save(track: Track, userId: string | undefined, position: number, duration: number, completed = false): void {
    this.select(userId);
    const id = this.identity(track);
    if (!id || !Number.isFinite(position) || position < 0) return;
    const bounded = Number.isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
    this.records[id] = { position: bounded, completed: completed || (duration > 0 && bounded >= duration), updated: Date.now() };
    const entries = Object.entries(this.records).sort((a, b) => b[1].updated - a[1].updated).slice(0, MAX_EPISODES);
    this.records = Object.fromEntries(entries);
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.records)); } catch { /* Keep the in-memory copy. */ }
  }
}
