import type { CatalogItem, Track } from '../types/music';
import { programTrack } from '../lib/program/tracks';

/** Resolve a bounded number at once and preserve collection order and occurrences. */
export async function resolveNativeCatalogProgram(items: readonly CatalogItem[], selectedIndex: number,
  resolve: (item: CatalogItem) => Promise<Track | null>, current: () => boolean) {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= items.length) throw new Error('Missing selected recording');
  const resolved: (Track | null)[] = Array(items.length).fill(null);
  let cursor = 0;
  let selectedFailed = false;
  const cancelled = () => { if (!current()) throw new DOMException('Obsolete collection', 'AbortError'); };
  async function worker() {
    while (cursor < items.length && !selectedFailed) {
      cancelled(); const index = cursor++;
      try {
        const track = await resolve(items[index]); cancelled();
        if (track && programTrack(track)) resolved[index] = track;
        if (index === selectedIndex && !resolved[index]) throw new Error('Selected recording unavailable');
      } catch (failure) {
        cancelled();
        if (index === selectedIndex) { selectedFailed = true; throw failure; }
      }
    }
  }
  // Settle workers before returning so a failed selection leaves no late work.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, items.length) }, worker));
  cancelled();
  const failure = workers.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  if (!resolved[selectedIndex]) throw new Error('Selected recording unavailable');
  const tracks = resolved.filter((track): track is Track => !!track);
  return { tracks, index: resolved.slice(0, selectedIndex).filter(Boolean).length, unavailable: items.length - tracks.length };
}
