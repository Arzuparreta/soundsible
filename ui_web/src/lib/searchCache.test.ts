import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSearchCache, writeSearchCache } from './searchCache';

afterEach(() => {
  vi.useRealTimers();
});

describe('search cache', () => {
  it('returns what was stored for the same query', () => {
    writeSearchCache('youtube', 'boards of canada', [{ id: 'a' }]);

    expect(readSearchCache('youtube', 'boards of canada')).toEqual([{ id: 'a' }]);
  });

  it('misses on an unseen query', () => {
    expect(readSearchCache('youtube', 'never searched')).toBeNull();
  });

  it('keeps namespaces apart so tabs cannot serve each other results', () => {
    writeSearchCache('catalog:songs', 'aphex', ['song']);
    writeSearchCache('catalog:artists', 'aphex', ['artist']);

    expect(readSearchCache('catalog:songs', 'aphex')).toEqual(['song']);
    expect(readSearchCache('catalog:artists', 'aphex')).toEqual(['artist']);
  });

  it('expires an entry once it is stale', () => {
    vi.useFakeTimers();
    writeSearchCache('youtube', 'stale', ['old']);

    vi.advanceTimersByTime(61_000);

    expect(readSearchCache('youtube', 'stale')).toBeNull();
  });

  it('is bounded, dropping the least recently written', () => {
    for (let i = 0; i < 45; i += 1) writeSearchCache('bounded', `q${i}`, [i]);

    expect(readSearchCache('bounded', 'q0')).toBeNull();
    expect(readSearchCache('bounded', 'q44')).toEqual([44]);
  });

  it('refreshes an entry’s position when it is written again', () => {
    for (let i = 0; i < 40; i += 1) writeSearchCache('reorder', `q${i}`, [i]);
    writeSearchCache('reorder', 'q0', ['refreshed']);
    for (let i = 40; i < 45; i += 1) writeSearchCache('reorder', `q${i}`, [i]);

    expect(readSearchCache('reorder', 'q0')).toEqual(['refreshed']);
  });
});
