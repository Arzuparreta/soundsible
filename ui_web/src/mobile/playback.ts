import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Track } from '../types/music';
import type { ProgramState, ProgramCommand, ProgramTransport } from '../lib/program/runtime';
interface PlaybackPlugin {
  state(): Promise<ProgramState>;
  command(options: ProgramCommand & { generation: number }): Promise<ProgramState>;
  addListener(event: 'playbackState', callback: (state: ProgramState) => void): Promise<PluginListenerHandle>;
}
export const playback = registerPlugin<PlaybackPlugin>('SoundsiblePlayback');
export const nativeProgramTransport: ProgramTransport = {
  state: () => playback.state(),
  command: command => playback.command(command),
  listen: async callback => { const listener = await playback.addListener('playbackState', callback); return () => { void listener.remove(); }; },
};
/** S2 local-file program: saved previews retain their own pending runtime gate. */
export function localProgram(tracks: Track[], selectedIndex: number): { tracks: Track[]; index: number } {
  const files = tracks.filter(track => track.source !== 'preview');
  const selected = tracks[selectedIndex];
  const index = selected && selected.source !== 'preview' ? tracks.slice(0, selectedIndex).filter(track => track.source !== 'preview').length : -1;
  return { tracks: files, index };
}
