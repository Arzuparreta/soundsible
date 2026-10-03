import type { Track } from '../../types/music';
import { isMusicTrack } from '../track';
import { coverUrl } from '../media';
import type { ProgramTrack } from './runtime';

/** The same eligibility rule drives rows, menus and queue conversion. */
export function programTrack(track: Track): ProgramTrack | null {
  if (!isMusicTrack(track) || typeof track.id !== 'string' || !track.id.trim() || track.id.length > 512 || (track.source !== undefined && track.source !== 'preview')) return null;
  const source = track.source === 'preview' ? 'preview' : 'local';
  if (source === 'preview' && !/^[A-Za-z0-9_-]{11}$/.test(track.id)) return null;
  return { source, id: track.id, title: track.title, artist: track.artist, album: track.album };
}
export const programCover = (track?: ProgramTrack): string | undefined =>
  track?.source === 'local' ? coverUrl(track.id, 'thumb') : undefined;

export function mixedProgram(tracks: Track[], selectedIndex: number): { tracks: ProgramTrack[]; index: number } {
  const converted = tracks.map(programTrack);
  return { tracks: converted.filter((track): track is ProgramTrack => track !== null),
    index: converted[selectedIndex] ? converted.slice(0, selectedIndex).filter(Boolean).length : -1 };
}
