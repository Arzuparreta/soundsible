import { io, type Socket } from 'socket.io-client';
import { apiOrigin } from './config';
import type { DeviceRegistration } from './api';

/** Server → client events (mirrors the legacy connection.js contract). */
export interface ServerToClientEvents {
  connect: () => void;
  disconnect: () => void;
  library_updated: () => void;
  downloader_log: (data: unknown) => void;
  downloader_update: (data: unknown) => void;
  discover_seed_ready: (data: { request_id: string; seed_track_id: string; recs: unknown[] }) => void;
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
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 8000,
    transports: ['websocket', 'polling'],
  });
}

/* ── Discover seed streaming ──
 * The server emits `discover_seed_ready` when an async seed expansion finishes.
 * nodeDiscover registers a handler here (avoiding a circular import with stores,
 * which owns the socket). stores' socket listener dispatches into this. */
type DiscoverSeedHandler = (data: {
  request_id: string;
  seed_track_id: string;
  recs: unknown[];
}) => void;
let _discoverSeedHandler: DiscoverSeedHandler | null = null;

export function setDiscoverSeedHandler(h: DiscoverSeedHandler | null): void {
  _discoverSeedHandler = h;
}

export function dispatchDiscoverSeed(data: {
  request_id: string;
  seed_track_id: string;
  recs: unknown[];
}): void {
  _discoverSeedHandler?.(data);
}
