import { io, type Socket } from 'socket.io-client';
import { apiOrigin } from './config';
import type { Device, DeviceCommandAnswer, DeviceRegistration, LivePlaybackState } from './api';
import type { DiscoveryFeedReadyEvent } from './discoveryEvents';
import type { PlaybackSessionSnapshot } from './playbackSession';
import type { Track } from '../types/music';

export interface DeviceCommandRequest {
  name: string;
  args?: Record<string, unknown>;
}

export type DeviceCommandAck = DeviceCommandAnswer;

export interface DeviceUpdatedEvent {
  device: Device;
  server_now_ms?: number;
}

export interface DeviceStateEvent {
  device_id: string;
  rev: number;
  track_id: string | null;
  track: Track | null;
  position_sec: number;
  is_playing: boolean;
  measured_at_ms?: number | null;
  live?: LivePlaybackState | null;
  session?: PlaybackSessionSnapshot | null;
  server_now_ms?: number;
}

export interface WatchDeviceAck {
  device: Device | null;
  state: DeviceStateEvent | null;
  server_now_ms?: number;
  error?: string;
}

/** Server → client events. */
export interface ServerToClientEvents {
  connect: () => void;
  disconnect: () => void;
  library_updated: () => void;
  /** The engine measured more of the library's loudness. */
  loudness_updated: () => void;
  saved_entities_updated: () => void;
  favourites_updated: () => void;
  downloader_log: (data: unknown) => void;
  downloader_update: (data: unknown) => void;
  discovery_feed_ready: (data: DiscoveryFeedReadyEvent) => void;
  device_command: (payload: DeviceCommandRequest, ack?: (response: DeviceCommandAck) => void) => void;
  device_updated: (payload: DeviceUpdatedEvent) => void;
  device_state: (payload: DeviceStateEvent) => void;
}

/** Client → server events. */
export interface ClientToServerEvents {
  playback_register: (registration: DeviceRegistration) => void;
  watch_device: (payload: { device_id: string }, ack?: (response: WatchDeviceAck) => void) => void;
  unwatch_device: (payload: { device_id: string }, ack?: (response: { ok?: boolean; device_id?: string }) => void) => void;
}

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(): AppSocket {
  return io(apiOrigin(), {
    // Fresh Manager so Engine.IO assigns a new sid (matches legacy behaviour).
    forceNew: true,
    reconnection: true,
    // A station may be unreachable longer than five attempts while a phone
    // changes networks. The manager owns backoff until the runtime disconnects.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    timeout: 8000,
    transports: ['websocket', 'polling'],
  });
}
