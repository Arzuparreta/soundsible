import { createMemo, type Accessor } from 'solid-js';

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** Keep a presentation's last projection while it is hidden. The inactive
 * branch reads no domain state, so updates neither rebuild the projection nor
 * discard the mounted view's scroll and editing state. When `deps` is given,
 * reopening with unchanged inputs reuses the last cached projection directly. */
export function createActivityMemo<T>(
  active: Accessor<boolean>,
  project: () => T,
  initial: T,
  deps?: () => readonly unknown[],
): Accessor<T> {
  let hasComputed = false;
  let cachedDeps: readonly unknown[] | undefined;
  let cachedValue: T = initial;
  return createMemo((previous) => {
    if (!active()) return previous;
    if (deps) {
      const nextDeps = deps();
      if (hasComputed && cachedDeps && sameDeps(cachedDeps, nextDeps)) {
        return cachedValue;
      }
      cachedDeps = nextDeps;
    }
    hasComputed = true;
    cachedValue = project();
    return cachedValue;
  }, initial);
}
