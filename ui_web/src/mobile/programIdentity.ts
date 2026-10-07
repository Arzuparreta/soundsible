import { trackKeys } from '../lib/playbackIdentity';
import type { ProgramState } from '../lib/program/runtime';
import type { Track } from '../types/music';

/** Source identities, not titles: acquiring a preview never retargets its occurrence. */
export function nativePlayingTrack(state: ProgramState | null, library: Track[], row: Track): boolean {
  const item = state?.items[state.index];
  if (!item) return false;
  const source = item.source === 'preview' ? { id: item.id, title: item.title, artist: item.artist, source: 'preview' as const }
    : library.find(track => track.id === item.id && track.source !== 'preview') ?? { id: item.id, title: item.title, artist: item.artist };
  const keys = new Set(trackKeys(source));
  return trackKeys(row).some(key => keys.has(key));
}
