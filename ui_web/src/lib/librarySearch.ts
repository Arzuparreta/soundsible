import type { ArtistEntry } from './libraryView';
import type { Track } from '../types/music';

export type LibrarySearchResult =
  | { kind: 'track'; track: Track; score: number; order: number }
  | { kind: 'artist'; artist: ArtistEntry; score: number; order: number };

export function normalizeLibraryQuery(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function fieldScore(field: string, query: string): number | null {
  const value = normalizeLibraryQuery(field);
  if (!value) return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 10;
  if (value.split(/\s+/).some((word) => word.startsWith(query))) return 20;
  if (value.includes(query)) return 30;
  return null;
}

function bestScore(query: string, fields: Array<[string | null | undefined, number]>): number | null {
  let best: number | null = null;
  for (const [field, penalty] of fields) {
    if (!field) continue;
    const score = fieldScore(field, query);
    if (score != null && (best == null || score + penalty < best)) best = score + penalty;
  }
  return best;
}

/** One deterministic, accent-insensitive result list for the local library. */
export function searchLibrary(
  tracks: Track[],
  artists: ArtistEntry[],
  rawQuery: string,
): LibrarySearchResult[] {
  const query = normalizeLibraryQuery(rawQuery);
  if (!query) return [];

  const results: LibrarySearchResult[] = [];
  tracks.forEach((track, order) => {
    const score = bestScore(query, [
      [track.title, 0],
      [track.artist, 2],
      [track.album, 4],
      [track.album_artist, 5],
    ]);
    if (score != null) results.push({ kind: 'track', track, score, order });
  });
  artists.forEach((artist, order) => {
    const score = bestScore(query, [[artist.name, 1]]);
    if (score != null) results.push({ kind: 'artist', artist, score, order });
  });

  return results.sort(
    (a, b) =>
      a.score - b.score ||
      (a.kind === b.kind ? a.order - b.order : a.kind === 'track' ? -1 : 1),
  );
}
