/**
 * The player's search panel lays its results out as one list, in the order the
 * server ranked them: whatever answers the query best first, then songs, then
 * a few artists and albums to jump to. The Search route is where results are
 * browsed in full; the panel keeps only what can be acted on at a glance.
 */
import { bodySections, resolveSections, topResultItem } from './searchSections';
import { resultCredit } from './queueDiscovery';
import { normalizeLibraryQuery } from './librarySearch';
import type { CatalogItem, CatalogSection, SearchResult, Track } from '../types/music';

/** Songs shown before "More songs". */
export const SONG_PREVIEW = 5;
/** Artists, albums and playlists shown of each. */
export const ENTITY_LIMIT = 3;

/** A song the panel lists: a track it can play now, or a catalog row that may
 * still need matching to a video. */
export type PanelSong = { track: Track } | { item: CatalogItem };

export interface PanelResults {
  /** An artist or album the server leads with, shown above the songs. */
  lead: CatalogItem | null;
  songs: PanelSong[];
  entities: CatalogItem[];
  playlists: string[];
}

const SONG_TYPES = new Set(['track', 'library_track']);
const ENTITY_TYPES = new Set(['artist', 'album']);

/** A YouTube result as the track the player plays. */
export function youtubeTrack(result: SearchResult): Track {
  return {
    id: result.id,
    title: result.title,
    ...resultCredit(result),
    duration: result.duration,
    cover: result.thumbnail,
    source: 'preview',
  };
}

export function panelResults(input: {
  query: string;
  items: CatalogItem[];
  sections: CatalogSection[];
  youtube: SearchResult[];
  direct: SearchResult | null;
  playlistNames: string[];
}): PanelResults {
  if (input.direct) return { lead: null, songs: [{ track: youtubeTrack(input.direct) }], entities: [], playlists: [] };
  const resolved = resolveSections(input.items, input.sections);
  const top = topResultItem(resolved);
  const lead = top && ENTITY_TYPES.has(top.type) ? top : null;
  const seen = new Set<string>(top ? [top.id] : []);
  const songs: PanelSong[] = top && SONG_TYPES.has(top.type) ? [{ item: top }] : [];
  const entities: CatalogItem[] = [];
  const counts = new Map<string, number>();
  for (const section of bodySections(resolved)) {
    for (const item of section.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (SONG_TYPES.has(item.type)) songs.push({ item });
      else if (ENTITY_TYPES.has(item.type) && (counts.get(item.type) ?? 0) < ENTITY_LIMIT) {
        counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
        entities.push(item);
      }
    }
  }
  // The catalog found no songs: YouTube's answer stands in, so the panel always
  // has something to play.
  if (!songs.length) songs.push(...input.youtube.map((result) => ({ track: youtubeTrack(result) })));
  const wanted = normalizeLibraryQuery(input.query);
  const playlists = wanted
    ? input.playlistNames.filter((name) => normalizeLibraryQuery(name).includes(wanted)).slice(0, ENTITY_LIMIT)
    : [];
  return { lead, songs, entities, playlists };
}
