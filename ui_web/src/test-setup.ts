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

// Unmount any components rendered in a test so leaked nodes from one test can't
// bleed into the next (the exact bug class this rewrite exists to kill).
afterEach(() => cleanup());
