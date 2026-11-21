import { io, type Socket } from 'socket.io-client';
import { apiOrigin } from './config';
import type { DeviceRegistration } from './api';
import type { DiscoveryFeedReadyEvent } from './discoveryEvents';

/** Server → client events (mirrors the legacy connection.js contract). */
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
  playback_stop_requested: () => void;
  playback_start_requested: (data: { state?: { position_sec?: number }; track?: Record<string, unknown> }) => void;
  playback_next_requested: () => void;
  playback_previous_requested: () => void;
  playback_seek_requested: (data: { position_sec?: number }) => void;
}

/** Client → server events. */
export interface ClientToServerEvents {
  playback_register: (registration: DeviceRegistration) => void;
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
