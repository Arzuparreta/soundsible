import { createSignal } from 'solid-js';
import type { Track } from '../types/music';

export type SortMode = 'recent' | 'az' | 'fav';

function persisted(key: string, def: string) {
  const [get, set] = createSignal(localStorage.getItem(key) ?? def);
  const setP = (v: string) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
    set(v);
  };
  return [get, setP] as const;
}

/** Persisted library browse preferences (shared so they survive navigation). */
export const [librarySort, setLibrarySort] = persisted('home:sort', 'recent');
export const [libraryTab, setLibraryTab] = persisted('home:tab', 'songs');

/** Sort a track list by the chosen mode. 'recent' keeps the engine's order. */
export function sortTracks(tracks: Track[], mode: string, favSet: Set<string>): Track[] {
  if (mode === 'az') return [...tracks].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  if (mode === 'fav') {
    return [...tracks].sort((a, b) => (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0));
  }
  // 'recent' — newest first (backend sends oldest → newest)
  return [...tracks].reverse();
}

export interface ArtistEntry {
  name: string;
  count: number;
  /** A track id to source the avatar cover from. */
  coverId: string;
}

/** Unique artists with track counts, alphabetically sorted. */
export function buildArtists(tracks: Track[]): ArtistEntry[] {
  const map = new Map<string, ArtistEntry>();
  for (const t of tracks) {
    const name = (t.artist || t.album_artist || 'Desconocido').trim();
    const key = name.toLowerCase();
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { name, count: 1, coverId: t.id });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface AlbumEntry {
  name: string;
  tracks: Track[];
  coverId: string;
}

/** Group an artist's tracks into albums, in first-seen order. */
export function buildAlbums(tracks: Track[]): AlbumEntry[] {
  const map = new Map<string, AlbumEntry>();
  for (const t of tracks) {
    const name = (t.album || 'Sin álbum').trim();
    const key = name.toLowerCase();
    const e = map.get(key);
    if (e) e.tracks.push(t);
    else map.set(key, { name, tracks: [t], coverId: t.id });
  }
  return [...map.values()];
}
