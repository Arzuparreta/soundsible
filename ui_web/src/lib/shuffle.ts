/**
 * Return a shuffled copy of `items` using Fisher–Yates.
 *
 * `array.sort(() => Math.random() - 0.5)` looks equivalent but is not: a
 * comparator that answers inconsistently for the same pair violates the
 * contract sort relies on, so the permutation it lands on is engine-dependent
 * and heavily biased toward leaving elements near where they started. That
 * matters here because callers play element 0 of the result — a biased shuffle
 * keeps offering the same few tracks.
 */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
