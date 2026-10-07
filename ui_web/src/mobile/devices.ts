import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export interface NativeDeviceState { generation: number; device_id: string | null; connected: boolean; can_handoff?: boolean; device_name?: string }
export const nativeDevices = registerPlugin<{
  deviceHandoff(options: { generation: number; device_id: string }): Promise<NativeDeviceState>;
  deviceState(): Promise<NativeDeviceState>;
  deviceRename(options: { generation: number; name: string }): Promise<NativeDeviceState>;
  addListener(event: 'nativeDeviceState', callback: (state: NativeDeviceState) => void): Promise<PluginListenerHandle>;
}>('SoundsiblePlayback');
