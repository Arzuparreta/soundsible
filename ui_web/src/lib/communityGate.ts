import { createSignal } from 'solid-js';

/** Where a hosted room's id survives a reload. Read here so the shell can tell
 * whether a broadcast needs resuming without loading the Live modules. */
export const ACTIVE_HOST_KEY = 'community:active-host:v1';

function storedHost(): boolean {
  try {
    return !!localStorage.getItem(ACTIVE_HOST_KEY);
  } catch {
    return false;
  }
}

/**
 * Whether the shell has to mount the broadcast bridge. True from boot when a
 * room is waiting to be resumed, and from the moment anything loads
 * `lib/community` otherwise. Until then Live, WebRTC and the bridge stay out
 * of the initial payload: a session that never opens Live never fetches them.
 */
export const [communityInUse, setCommunityInUse] = createSignal(storedHost());
