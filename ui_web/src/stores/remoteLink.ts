import { createSignal } from 'solid-js';
import type { PlaybackState } from './core';

/** The remote-control store (stores/remote), once stores/runtime has loaded it
 * with the socket. It stays out of the initial bundle: until it is loaded no
 * other device can be controlled, so the player shows this one. */
export const [remoteStore, setRemoteStore] = createSignal<typeof import('./remote') | null>(null);

/** The controlled device's playback while another device is controlled, so
 * stores/identity.ts marks its songs in lists. Here rather than in the player
 * store: identity.ts cannot import that (stores/index.ts re-exports identity.ts
 * and builds its memos at module load, which would close an initialization cycle). */
export const [controlledPlayback, setControlledPlayback] =
  createSignal<Pick<PlaybackState, 'currentTrack' | 'queue' | 'index'> | null>(null);
