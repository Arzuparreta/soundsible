import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Device } from '../lib/api';
import type { DeviceStateEvent, WatchDeviceAck } from '../lib/socket';
export interface NativeDeviceState { generation: number; device_id: string | null; connected: boolean; device_name?: string }
/** The account events the native service's socket receives, tagged with the account generation. */
export interface NativeDeviceUpdated { generation: number; device: Device; server_now_ms?: number }
export type NativeDeviceStateEvent = DeviceStateEvent & { generation: number };
export const nativeDevices = registerPlugin<{
  deviceState(): Promise<NativeDeviceState>;
  deviceRename(options: { generation: number; name: string }): Promise<NativeDeviceState>;
  /** Watch a device on the service's socket (`null` stops watching). The service watches it again after a reconnect. */
  deviceWatch(options: { generation: number; device_id: string | null }): Promise<WatchDeviceAck>;
  addListener(event: 'nativeDeviceState', callback: (state: NativeDeviceState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'device_updated', callback: (event: NativeDeviceUpdated) => void): Promise<PluginListenerHandle>;
  addListener(event: 'device_state', callback: (event: NativeDeviceStateEvent) => void): Promise<PluginListenerHandle>;
}>('SoundsiblePlayback');
