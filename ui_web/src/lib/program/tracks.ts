import type { Track } from '../../types/music';
import { isMusicTrack, isPodcastTrack } from '../track';
import { coverUrl } from '../media';
import type { ProgramTrack } from './runtime';

/** The same eligibility rule drives rows, menus and queue conversion. */
export function programTrack(track: Track): ProgramTrack | null {
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
  return { source, id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, loudness_lufs: track.loudness_lufs, loudness_peak_dbtp: track.loudness_peak_dbtp };
}
export const programCover = (track?: ProgramTrack): string | undefined =>
  track?.source === 'local' && !track.offline ? coverUrl(track.id, 'thumb') : undefined;

export function mixedProgram(tracks: Track[], selectedIndex: number): { tracks: ProgramTrack[]; index: number } {
  const converted = tracks.map(programTrack);
  return { tracks: converted.filter((track): track is ProgramTrack => track !== null),
    index: converted[selectedIndex] ? converted.slice(0, selectedIndex).filter(Boolean).length : -1 };
}
