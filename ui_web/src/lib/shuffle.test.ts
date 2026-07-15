import { describe, expect, it, vi } from 'vitest';
import { shuffled } from './shuffle';

describe('shuffled', () => {
  it('does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffled(input);
    expect(input).toEqual(copy);
  });

  it('keeps every element exactly once', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    expect([...shuffled(input)].sort((a, b) => a - b)).toEqual(input);
  });

  it('handles empty and single-element lists', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(['only'])).toEqual(['only']);
  });

  it('walks the array once from the end, picking j within the unshuffled prefix', () => {
    // Fisher–Yates draws exactly n-1 times: on step i it must pick from
    // [0, i], never the whole array — that constraint is what makes every
    // permutation equally likely.
    const draws: number[] = [];
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      draws.push(0.999999);
      return 0.999999;
    });
    try {
      expect(shuffled([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
      expect(draws).toHaveLength(3);
    } finally {
      random.mockRestore();
    }
  });

  it('leaves element 0 in front only about 1/n of the time', () => {
    // The regression this guards: `sort(() => Math.random() - 0.5)` leaves
    // element 0 in front ~21.7% of the time for n=8 rather than the fair 12.5%.
    // The bound below sits between the two — a fair shuffle clears it by many
    // standard deviations (σ ≈ 0.5% here), a sort-based one fails it outright.
    const input = [0, 1, 2, 3, 4, 5, 6, 7];
    const runs = 5000;
    let stayedFirst = 0;
    for (let i = 0; i < runs; i++) {
      if (shuffled(input)[0] === 0) stayedFirst++;
    }
    const rate = stayedFirst / runs;
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.17);
  });

  it('produces more than one distinct ordering', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(shuffled(input).join(','));
    expect(seen.size).toBeGreaterThan(10);
  });
});
