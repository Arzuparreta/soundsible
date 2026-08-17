import { describe, it, expect } from 'vitest';
import { addedAtMs, byRecency } from './libraryOrder';
import type { Track } from '../types/music';

const t = (id: string, added_at?: string | null): Track => ({
  id,
  title: id,
  artist: 'A',
  ...(added_at === undefined ? {} : { added_at }),
});

describe('addedAtMs', () => {
  it('reads the engine’s naive UTC timestamps', () => {
    expect(addedAtMs(t('a', '2026-08-05T00:52:05.651624'))).toBeGreaterThan(
      addedAtMs(t('b', '2026-08-04T22:03:11.794420'))!,
    );
  });

  it('is null for a song with no date, and for a date nobody can read', () => {
    expect(addedAtMs(t('a'))).toBeNull();
    expect(addedAtMs(t('b', null))).toBeNull();
    expect(addedAtMs(t('c', 'whenever'))).toBeNull();
  });
});

describe('byRecency', () => {
  it('interleaves songs however they are held, newest first', () => {
    // The shape of the bug: the file is newer than one save and older than the
    // other, which no block ordering can express.
    const out = byRecency([
      t('file-july', '2026-07-02T10:00:00'),
      t('saved-today', '2026-08-17T10:06:52'),
      t('saved-june', '2026-06-01T09:00:00'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['saved-today', 'file-july', 'saved-june']);
  });

  it('leaves an undated library exactly as it arrived', () => {
    // An engine that has not been upgraded yet sends no dates at all. That must
    // read as the previous behaviour rather than as a reshuffle.
    const input = [t('a'), t('b'), t('c')];
    expect(byRecency(input).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(input.map((x) => x.id)).toEqual(['a', 'b', 'c']); // not mutated
  });

  it('sorts undated songs below dated ones, keeping their own order', () => {
    const out = byRecency([t('undated-1'), t('dated', '2026-01-01T00:00:00'), t('undated-2')]);
    expect(out.map((x) => x.id)).toEqual(['dated', 'undated-1', 'undated-2']);
  });

  it('breaks a tie on the order it was given', () => {
    const out = byRecency([t('first', '2026-08-01T00:00:00'), t('second', '2026-08-01T00:00:00')]);
    expect(out.map((x) => x.id)).toEqual(['first', 'second']);
  });
});
