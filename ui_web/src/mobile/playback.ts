import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
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
export { mixedProgram } from '../lib/program/tracks';
