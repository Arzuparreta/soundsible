import type { Track } from '../types/music';
import { isMusicTrack } from './track';
import { byRecency } from './libraryOrder';

/** Shared file + saved-song ordering; callers resolve saved identities first. */
export function musicLibraryRows(library: Track[], saved: Track[]): Track[] {
  const files = library.filter(isMusicTrack).reverse();
  const streaming = saved.filter(track => track.source === 'preview' && isMusicTrack(track));
  return byRecency(streaming.length === 0 ? files : [...files, ...streaming]);
}
