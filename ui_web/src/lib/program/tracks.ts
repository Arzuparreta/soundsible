import type { Track } from '../../types/music';
import { isMusicTrack, isPodcastTrack } from '../track';
import { coverUrl } from '../media';
import type { ProgramTrack } from './runtime';

/** The record and the song's place on it, for the native queue to show and
 * to hand back to a download. Only what is actually known travels. */
function release(track: Track): Pick<ProgramTrack, 'album_artist' | 'track_number' | 'disc_number' | 'year'> {
  const whole = (value: unknown, high: number, low = 1) =>
    typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : undefined;
  const albumArtist = typeof track.album_artist === 'string' && track.album_artist.length <= 4096 ? track.album_artist : undefined;
  return { album_artist: albumArtist, track_number: whole(track.track_number, 999), disc_number: whole(track.disc_number, 99), year: whole(track.year, 9999, 1000) };
}

/** The same eligibility rule drives rows, menus and queue conversion. */
export function programTrack(track: Track): ProgramTrack | null {
  const pending = (track as import('../playbackQueue').ContextTrack).pendingResolve;
  if (pending) {
    if (isPodcastTrack(track) || !track.id || track.id.length > 512 || !pending.catalogItemId || pending.catalogItemId.length > 512 ||
      typeof pending.artist !== 'string' || pending.artist.length > 4096 || !pending.title || pending.title.length > 4096) return null;
    return { source: 'pending', id: track.id, title: track.title, artist: track.artist, album: track.album, ...release(track), duration: track.duration, pendingResolve: { ...pending } };
  }
  if (isPodcastTrack(track)) {
    if (track.source !== undefined && track.source !== 'preview') return null;
    const enclosure = track.podcast_enclosure_url;
    if ((enclosure && (enclosure.length > 8192 || !/^https?:\/\//i.test(enclosure))) || !track.id || track.id.length > 8192) return null;
    if (!enclosure && (track.source === 'preview' || !track.podcast_episode_guid || !track.podcast_feed_id)) return null;
    return { source: track.source === 'preview' ? 'podcast' : 'local', mediaKind: 'podcast_episode', enclosure: enclosure ?? undefined, episodeGuid: track.podcast_episode_guid ?? undefined, feedId: track.podcast_feed_id ?? undefined, id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, loudness_lufs: track.loudness_lufs, loudness_peak_dbtp: track.loudness_peak_dbtp };
  }
  if (!isMusicTrack(track) || typeof track.id !== 'string' || !track.id.trim() || track.id.length > 512 || (track.source !== undefined && track.source !== 'preview')) return null;
  const source = track.source === 'preview' ? 'preview' : 'local';
  if (source === 'preview' && !/^[A-Za-z0-9_-]{11}$/.test(track.id)) return null;
  return { source, id: track.id, title: track.title, artist: track.artist, album: track.album, ...release(track), duration: track.duration, loudness_lufs: track.loudness_lufs, loudness_peak_dbtp: track.loudness_peak_dbtp };
}
export const programCover = (track?: ProgramTrack): string | undefined =>
  track?.source === 'local' && !track.offline ? coverUrl(track.id, 'thumb') : undefined;

export function mixedProgram(tracks: Track[], selectedIndex: number): { tracks: ProgramTrack[]; index: number } {
  const converted = tracks.map(programTrack);
  return { tracks: converted.filter((track): track is ProgramTrack => track !== null),
    index: converted[selectedIndex] ? converted.slice(0, selectedIndex).filter(Boolean).length : -1 };
}

/** The song a native queue row stands for, for its menu. The library's own
 * track wins when it holds a file; a stream takes the record it is queued
 * with — whole, so two releases never mix — since that is where its download
 * will be filed. */
export function queueTrack(entry: ProgramTrack, held?: Track): Track {
  const record = entry.album ? { album: entry.album, album_artist: entry.album_artist, track_number: entry.track_number, disc_number: entry.disc_number, year: entry.year } : {};
  if (held) return held.source === 'preview' ? { ...held, ...record } : held;
  return {
    id: entry.id, title: entry.title, artist: entry.artist, album: entry.album, duration: entry.duration, ...record,
    source: entry.source === 'preview' || entry.source === 'podcast' ? 'preview' : undefined,
    ...(entry.mediaKind === 'podcast_episode' ? { media_kind: 'podcast_episode' as const, podcast_feed_id: entry.feedId,
      podcast_episode_guid: entry.episodeGuid, podcast_enclosure_url: entry.enclosure } : {}),
  } as Track;
}
