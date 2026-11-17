import { createMemo, type Accessor } from 'solid-js';

/** Keep a presentation's last projection while it is hidden. The inactive
 * branch reads no domain state, so updates neither rebuild the projection nor
 * discard the mounted view's scroll and editing state. Audio never uses this. */
export function createActivityMemo<T>(active: Accessor<boolean>, project: () => T, initial: T): Accessor<T> {
  return createMemo(previous => active() ? project() : previous, initial);
}
