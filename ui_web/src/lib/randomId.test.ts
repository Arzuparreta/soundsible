import { afterEach, expect, it, vi } from 'vitest';
import { randomId } from './randomId';

afterEach(() => vi.unstubAllGlobals());

it('uses random values for distinct UUIDs when plain HTTP hides randomUUID', () => {
  const values = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues: values });
  const ids = Array.from({ length: 100 }, randomId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

it('preserves the fallback for older browsers without a crypto API', () => {
  vi.stubGlobal('crypto', undefined);
  expect(randomId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
