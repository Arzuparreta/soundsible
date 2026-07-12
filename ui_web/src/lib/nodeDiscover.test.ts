import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: {} }));
vi.mock('../stores', () => ({ state: { library: [], favorites: [] } }));
vi.mock('./prefetch', () => ({ prefetchPreviews: vi.fn() }));

import { interleave, pickWeighted, seedWeight, type SeedExpansion } from './nodeDiscover';

describe('seedWeight', () => {
  it('prefers recently added tracks gradually', () => {
    const newest = seedWeight({ recencyRank: 0, fav: false, recentlyUsed: false });
    const mid = seedWeight({ recencyRank: 25, fav: false, recentlyUsed: false });
    const old = seedWeight({ recencyRank: 100, fav: false, recentlyUsed: false });
    expect(newest).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0); // gradual preference, never excluded
    expect(mid / newest).toBeCloseTo(0.5, 5); // half-life = 25 tracks
  });

  it('boosts favourites and damps recently used seeds', () => {
    const base = seedWeight({ recencyRank: 10, fav: false, recentlyUsed: false });
    expect(seedWeight({ recencyRank: 10, fav: true, recentlyUsed: false })).toBeGreaterThan(base);
    expect(seedWeight({ recencyRank: 10, fav: false, recentlyUsed: true })).toBeLessThan(base);
  });
});

describe('pickWeighted', () => {
  const cand = (id: string, recencyRank: number) => ({ id, recencyRank, fav: false, recentlyUsed: false });

  it('samples without replacement and respects the count', () => {
    const picked = pickWeighted([cand('a', 0), cand('b', 1), cand('c', 2)], 2);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
  });

  it('returns the whole pool when asking for more than exists', () => {
    expect(pickWeighted([cand('a', 0)], 5)).toHaveLength(1);
  });

  it('lands on the heaviest candidate under an injected mid-range rand', () => {
    // Weights: new=1, mid≈0.57, old=0.25 → at rand=0.5 the cursor falls in the
    // biggest slice each round: first 'new', then 'mid'.
    const pool = [cand('old', 50), cand('new', 0), cand('mid', 20)];
    const picked = pickWeighted(pool, 2, () => 0.5);
    expect(picked.map((p) => p.id)).toEqual(['new', 'mid']);
  });
});

describe('interleave', () => {
  const rec = (id: string) => ({ id, title: id });
  const exp = (seedId: string, ids: string[]): SeedExpansion => ({
    seed: { id: seedId, title: `t-${seedId}`, artist: `a-${seedId}` },
    recs: ids.map(rec),
  });

  it('round-robins one item per seed per round with seed attribution', () => {
    const out = interleave([exp('s1', ['a', 'b']), exp('s2', ['c', 'd'])], new Set(), 10);
    expect(out.map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(out[0].seedId).toBe('s1');
    expect(out[1].seedId).toBe('s2');
  });

  it('drops excluded ids (library) and cross-seed duplicates', () => {
    const out = interleave(
      [exp('s1', ['lib', 'a', 'dup']), exp('s2', ['dup', 'b'])],
      new Set(['lib']),
      10,
    );
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b', 'dup']);
    expect(out.filter((r) => r.id === 'dup')).toHaveLength(1);
  });

  it('respects the limit and terminates when all lists are drained', () => {
    expect(interleave([exp('s1', ['a', 'b', 'c'])], new Set(), 2)).toHaveLength(2);
    expect(interleave([exp('s1', ['a'])], new Set(['a']), 10)).toHaveLength(0);
  });
});
