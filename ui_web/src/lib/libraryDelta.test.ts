import { expect, it } from 'vitest';
import type { LibraryDelta } from './api';
import type { Track } from '../types/music';
import { applyLibraryDelta } from './libraryDelta';

const revision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const tracks: Track[] = [
  { id: 'one', title: 'One', artist: 'Artist', loudness_lufs: -12 },
  { id: 'two', title: 'Two', artist: 'Artist' },
];
function delta(patch: Partial<LibraryDelta> = {}): LibraryDelta {
  return { kind: 'delta', base_revision: revision, revision: nextRevision, upserts: [], removed: [], fields: {}, ...patch };
}

it('replaces changed rows completely, preserving unchanged objects and input data', () => {
  const result = applyLibraryDelta(tracks, delta({ upserts: [{ id: 'one', title: 'Edited', artist: 'Artist' }] }), `W/"${revision}"`);
  expect(result.tracks[0]).not.toHaveProperty('loudness_lufs');
  expect(result.tracks[1]).toBe(tracks[1]);
  expect(tracks[0].loudness_lufs).toBe(-12);
  expect(result.revision).toBe(`W/"${nextRevision}"`);
});

it('adds, removes and reorders without touching surviving rows', () => {
  const result = applyLibraryDelta(tracks, delta({
    upserts: [{ id: 'three', title: 'Three', artist: 'Artist' }], removed: ['one'], order: ['three', 'two'],
  }), revision);
  expect(result.tracks.map(t => t.id)).toEqual(['three', 'two']);
  expect(result.tracks[1]).toBe(tracks[1]);
});

it('preserves the array when only header fields change and supports empty libraries', () => {
  expect(applyLibraryDelta(tracks, delta({ fields: { playlists: {} } }), revision).tracks).toBe(tracks);
  expect(applyLibraryDelta(tracks, delta({ removed: ['one', 'two'], order: [] }), revision).tracks).toEqual([]);
});

it.each([
  { base_revision: 'wrong' }, { revision: 'invalid' }, { removed: ['absent'] },
  { removed: ['one', 'one'] }, { order: ['one', 'one'] }, { order: ['one'] },
  { upserts: [{ id: 'three', title: 'Three' }] },
  { upserts: [tracks[0], tracks[0]] }, { removed: ['one'], upserts: [tracks[0]], order: ['one', 'two'] },
  { fields: { tracks: [] } }, { fields: { playlists: { bad: null } } },
  { fields: { settings: null } }, { fields: { podcast_subscriptions: [null] } },
])('rejects inconsistent delta before application: %j', patch => {
  expect(() => applyLibraryDelta(tracks, delta(patch as Partial<LibraryDelta>), revision)).toThrow();
  expect(tracks[0].title).toBe('One');
});
