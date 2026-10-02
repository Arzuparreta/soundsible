import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Track } from '../types/music';
export interface PlaybackState {
  generation: number; ready: boolean; playing: boolean; state: number; index: number;
  id: string; title: string; artist: string; queue: string[]; positionMs: number; durationMs: number; error: number; errorStatus: number;
}
interface PlaybackPlugin {
  state(): Promise<PlaybackState>;
  command(options: { generation: number; action: string; tracks?: Pick<Track, 'id' | 'title' | 'artist' | 'album'>[]; index?: number; positionMs?: number }): Promise<PlaybackState>;
  addListener(event: 'playbackState', callback: (state: PlaybackState) => void): Promise<PluginListenerHandle>;
}
export const playback = registerPlugin<PlaybackPlugin>('SoundsiblePlayback');
/** S2 local-file program: saved previews retain their own pending runtime gate. */
export function localProgram(tracks: Track[], selectedIndex: number): { tracks: Track[]; index: number } {
  const files = tracks.filter(track => track.source !== 'preview');
  const selected = tracks[selectedIndex];
  const index = selected && selected.source !== 'preview' ? tracks.slice(0, selectedIndex).filter(track => track.source !== 'preview').length : -1;
  return { tracks: files, index };
}
