import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { LiveSession, LiveProgram, LiveChatMessage, CommunityConfig } from '../lib/community';
export interface NativeRoomState {
  generation: number; session: LiveSession | null; connected: boolean;
  playing?: boolean; volume?: number; program: LiveProgram | null; messages: LiveChatMessage[];
}
export interface NativeLiveState {
  generation: number; ready: boolean; host: NativeRoomState | null; listener: NativeRoomState | null;
}
export type NativeLiveCommand = { action: 'liveStart' | 'liveStop' | 'liveTitle' | 'liveChat' | 'liveListen' | 'liveLeave' | 'livePause' | 'liveResume' | 'liveVolume';
  generation: number; title?: string; text?: string; volume?: number; session?: LiveSession & { api_url: string; guest_name: string } };
export const nativeLive = registerPlugin<{
  liveState(): Promise<NativeLiveState>;
  liveDirectory(options: { generation: number }): Promise<{ config: CommunityConfig; sessions: LiveSession[] }>; 
  liveCommand(command: NativeLiveCommand): Promise<NativeLiveState>;
  addListener(event: 'nativeLiveState', callback: (state: NativeLiveState) => void): Promise<PluginListenerHandle>;
}>('SoundsiblePlayback');
