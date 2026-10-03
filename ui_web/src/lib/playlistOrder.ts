import type { PlaylistMap } from '../types/music';
/** Mapping key order is lost by sorted JSON and numeric JavaScript keys. */
export function playlistNames(playlists: PlaylistMap, order?: unknown): string[] {
  const result: string[] = [];
  for (const name of Array.isArray(order) ? order : []) if (typeof name === 'string' && Object.hasOwn(playlists, name) && !result.includes(name)) result.push(name);
  return [...result, ...Object.keys(playlists).filter(name => !result.includes(name)).sort()];
}
