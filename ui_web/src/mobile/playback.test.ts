import { expect, it } from 'vitest';
import { mixedProgram } from './playback';
import { programTrack } from '../lib/program/tracks';
import type { Track } from '../types/music';
const one = { id: 'one', title: 'one', artist: 'artist' } as Track;
const preview = { ...one, id: 'A1111111111', source: 'preview', youtube_id: 'B1111111111' } as Track;
it('preserves mixed order, duplicates and selected index while excluding unresolved entries', () => {
  const unresolved = { ...preview, id: 'yt:pending' };
  const queue = mixedProgram([unresolved, preview, one, preview], 3);
  expect(queue.tracks.map(t => [t.source, t.id])).toEqual([['preview', preview.id], ['local', 'one'], ['preview', preview.id]]);
  expect(queue.index).toBe(2);
  expect(mixedProgram([unresolved, one], 0).index).toBe(-1);
});
it('rejects podcast previews and unsafe ids without trusting URLs or youtube_id', () => {
  for (const id of ['', '../escape', 'A111111111é', 'a'.repeat(12)]) expect(programTrack({ ...preview, id })).toBeNull();
  expect(programTrack({ ...preview, podcast_episode_guid: 'episode' })).toBeNull();
  expect(programTrack({ ...preview, source: 'unknown' } as unknown as Track)).toBeNull();
  expect(programTrack({ ...one, id: '   ' })).toBeNull();
  expect(programTrack(preview)?.id).toBe(preview.id);
});
