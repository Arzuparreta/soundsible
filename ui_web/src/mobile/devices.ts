import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export interface NativeDeviceState { generation: number; device_id: string | null; connected: boolean }
export const nativeDevices = registerPlugin<{
  deviceState(): Promise<NativeDeviceState>;
  addListener(event: 'nativeDeviceState', callback: (state: NativeDeviceState) => void): Promise<PluginListenerHandle>;
}>('SoundsiblePlayback');
