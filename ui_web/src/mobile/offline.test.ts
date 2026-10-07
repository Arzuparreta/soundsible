import { describe, it, expect } from 'vitest';
import { acquiredMusic, availableLibrary, availableProgram, type OfflineState } from './offline';
import type { Track } from '../types/music';
const song = (id: string): Track => ({ id, title: id, artist: 'Artist', album: 'Album' });
const state: OfflineState = { user: null, usedBytes: 100, limitBytes: 1000, playlists: { flight: ['a', 'missing', 'a', 'b'] }, items: [
  { track: song('a'), state: 'ready', bytes: 100, total: 100, error: '' },
  { track: song('b'), state: 'downloading', bytes: 10, total: 100, error: '' },
] };
describe('explicit offline selection', () => {
  it('never silently acquires previews or podcasts', () => {
    expect(acquiredMusic([song('a'), { ...song('A1111111111'), source: 'preview' }, { ...song('pod'), podcast_episode_guid: 'ep' }]).map(t => t.id)).toEqual(['a']);
  });
  it('keeps only complete copies and preserves playlist occurrences', () => {
    expect(availableLibrary(state)).toEqual({ tracks: [song('a')], playlists: { flight: ['a', 'a'] } });
  });
  it('maps selected occurrence through unavailable songs and keeps duplicates', () => {
    expect(availableProgram([song('missing'), song('a'), song('b'), song('a')], 3, state)).toEqual({ tracks: [song('a'), song('a')], index: 1 });
    expect(availableProgram([song('b'), song('a')], 0, state).index).toBe(-1);
  });
});
