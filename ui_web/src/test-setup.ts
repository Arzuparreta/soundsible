import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@solidjs/testing-library';

// jsdom in this environment doesn't expose localStorage, but several modules
// read it at import time (persisted browse preferences). Provide a minimal
// in-memory shim before any test module loads.
if (typeof globalThis.localStorage === 'undefined') {
  class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number {
      return this.store.size;
    }
    clear(): void {
      this.store.clear();
    }
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null;
    }
    key(index: number): string | null {
      return [...this.store.keys()][index] ?? null;
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
  }
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage() });
}

/**
 * jsdom's `matchMedia` always answers `false` and never changes, so a component
 * that adapts to the breakpoint could only ever be tested at one size. This
 * replaces it with one that remembers an answer per query and notifies its
 * listeners when the answer changes — which is the whole contract the app uses.
 */
type MediaListener = (event: MediaQueryListEvent) => void;
const mediaListeners = new Map<string, Set<MediaListener>>();
const mediaMatches = new Map<string, boolean>();

if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => {
    const listeners = mediaListeners.get(query) ?? new Set<MediaListener>();
    mediaListeners.set(query, listeners);
    return {
      media: query,
      get matches() {
        return mediaMatches.get(query) ?? false;
      },
      onchange: null,
      addEventListener: (_type: string, fn: MediaListener) => listeners.add(fn),
      removeEventListener: (_type: string, fn: MediaListener) => listeners.delete(fn),
      addListener: (fn: MediaListener) => listeners.add(fn),
      removeListener: (fn: MediaListener) => listeners.delete(fn),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** Answer `query` with `matches` from now on, and tell whoever is listening. */
export function setMediaQuery(query: string, matches: boolean): void {
  mediaMatches.set(query, matches);
  for (const fn of mediaListeners.get(query) ?? []) {
    fn({ matches, media: query } as MediaQueryListEvent);
  }
}

/** Unmount any components rendered in a test so leaked nodes from one test can't
 *  bleed into the next (the exact bug class this rewrite exists to kill). */
afterEach(() => cleanup());
