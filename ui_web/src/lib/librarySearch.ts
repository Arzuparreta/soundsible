import type { ArtistEntry } from './libraryView';
import type { SavedEntity } from './savedEntityIdentity';
import type { Track } from '../types/music';

export type LibrarySearchResult =
  | { kind: 'track'; track: Track; score: number; order: number }
  | { kind: 'artist'; artist: ArtistEntry; score: number; order: number };

/**
 * NFKD folds compatibility forms (the `ﬃ` ligature, full-width letters);
 * stripping only `Diacritic` marks lets `bjork` find `Björk` while keeping the
 * vowel signs that tell Devanagari or Thai words apart.
 */
export function normalizeLibraryQuery(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export type SearchFieldValue = string | null | undefined;

function matchedField(field: SearchFieldValue, query: string): string | undefined {
  if (!field) return undefined;
  const value = normalizeLibraryQuery(field);
  return value.includes(query) ? value : undefined;
}

function matchesLocalQuery(query: string, fields: readonly SearchFieldValue[]): boolean {
  return !query || fields.some(field => matchedField(field, query) !== undefined);
}

export function filterLocalCollection<T>(items: T[], query: string, fields: (item: T) => SearchFieldValue[]): T[] {
  return query ? items.filter(item => matchesLocalQuery(query, fields(item))) : items;
}

export function trackSearchFields(track: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'album_artist'>>): SearchFieldValue[] {
  return [track.title, track.artist, track.album, track.album_artist];
}

export function podcastShowSearchFields(show: { title: string; author?: string | null }): SearchFieldValue[] {
  return [show.title, show.author];
}

export function liveRoomSearchFields(room: { title: string; host: { display_name: string } }): SearchFieldValue[] {
  return [room.title, room.host.display_name];
}

export function matchesSavedEntity(entry: SavedEntity, query: string): boolean {
  return matchesLocalQuery(query, [`${entry.name} ${entry.artist ?? ''}`]);
}

function fieldScore(field: SearchFieldValue, query: string): number | null {
  const value = matchedField(field, query);
  if (!value) return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 10;
  if (value.split(/\s+/).some((word) => word.startsWith(query))) return 20;
  return 30;
}

function bestScore(query: string, fields: SearchFieldValue[], weights: number[]): number | null {
  let best: number | null = null;
  fields.forEach((field, index) => {
    const score = fieldScore(field, query);
    if (score === null) return;
    const weighted = score + weights[index];
    if (best === null || weighted < best) best = weighted;
  });
  return best;
}

const TRACK_FIELD_WEIGHTS = [0, 2, 4, 5];

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
    const score = bestScore(query, trackSearchFields(track), TRACK_FIELD_WEIGHTS);
    if (score != null) results.push({ kind: 'track', track, score, order });
  });
  artists.forEach((artist, order) => {
    const score = bestScore(query, [artist.name], [1]);
    if (score != null) results.push({ kind: 'artist', artist, score, order });
  });

  return results.sort(
    (a, b) =>
      a.score - b.score ||
      (a.kind === b.kind ? a.order - b.order : a.kind === 'track' ? -1 : 1),
  );
}
