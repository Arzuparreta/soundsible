import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';

const library: Track[] = [
  { id: 'd1t1', title: 'First', artist: 'Artist' },
  { id: 'd1t2', title: 'Second', artist: 'Artist' },
  { id: 'd2t1', title: 'Third', artist: 'Artist' },
];

vi.mock('../stores', () => ({ musicLibrary: () => library }));

import { tracksByIds } from './catalogTracks';

describe('tracksByIds', () => {
  it('keeps the engine’s order rather than the library’s', () => {
    // The catalog answers in disc/track order. The library array is in whatever
    // order the manifest holds, and sorting again here would mean deciding a
    // second time what "in order" means.
    const out = tracksByIds(['d2t1', 'd1t1']);
    expect(out.map((track) => track.id)).toEqual(['d2t1', 'd1t1']);
  });

  it('drops an id the library cannot place instead of leaving a hole', () => {
    // A song saved without downloading it has no catalog row, and a catalog row
    // whose file has just gone has no track. The shorter list is the honest one;
    // an `undefined` in a queue is a crash.
    const out = tracksByIds(['d1t1', 'not-here', 'd1t2']);
    expect(out.map((track) => track.id)).toEqual(['d1t1', 'd1t2']);
  });

  it('answers an empty request without touching the library', () => {
    expect(tracksByIds([])).toEqual([]);
  });
});
