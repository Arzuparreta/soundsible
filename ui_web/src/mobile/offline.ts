import { registerPlugin } from '@capacitor/core';
import type { Track, PlaylistMap } from '../types/music';
import type { User } from '../lib/session';
import { programTrack } from '../lib/program/tracks';

export interface OfflineItem { track: Track; state: 'queued' | 'downloading' | 'ready' | 'error'; bytes: number; total: number; error: string }
export interface OfflineState { user: User | null; items: OfflineItem[]; usedBytes: number; limitBytes: number; playlists: PlaylistMap }
export type OfflineCommand = { action: 'state' } | { action: 'prepare'; tracks: Track[]; playlists: PlaylistMap } | { action: 'remove'; ids: string[] } | { action: 'limit'; bytes: number };
export const offline = registerPlugin<{ command(command: OfflineCommand & { generation: number }): Promise<OfflineState> }>('SoundsibleOffline');
export const acquiredMusic = (tracks: Track[]): Track[] => tracks.filter(track => programTrack(track)?.source === 'local');
export function availableLibrary(state: OfflineState): { tracks: Track[]; playlists: PlaylistMap } {
  const tracks = state.items.filter(item => item.state === 'ready').map(item => item.track);
  const ids = new Set(tracks.map(track => track.id));
  return { tracks, playlists: Object.fromEntries(Object.entries(state.playlists ?? {}).map(([name, rows]) => [name, rows.filter(id => ids.has(id))]).filter(([, rows]) => rows.length)) };
}
export function availableProgram(tracks: Track[], index: number, state: OfflineState): { tracks: Track[]; index: number } {
  const ids = new Set(state.items.filter(item => item.state === 'ready').map(item => item.track.id));
  const selected = tracks[index];
  if (!selected || !ids.has(selected.id) || !acquiredMusic([selected]).length) return { tracks: [], index: -1 };
  return { tracks: tracks.filter(track => ids.has(track.id) && acquiredMusic([track]).length), index: tracks.slice(0, index).filter(track => ids.has(track.id) && acquiredMusic([track]).length).length };
}
