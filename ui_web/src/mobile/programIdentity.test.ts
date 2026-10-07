import { expect, it } from 'vitest';
import { nativePlayingTrack } from './programIdentity';
import type { ProgramState } from '../lib/program/runtime';
const program = { index: 0, items: [{ source: 'preview', id: 'B1111111111', title: 'Song', artist: 'Artist' }] } as ProgramState;
it('keeps an acquired row active through its exact YouTube identity without retargeting the occurrence', () => {
  const row = { id: 'hash', title: 'Song', artist: 'Artist', youtube_id: 'B1111111111' };
  expect(nativePlayingTrack(program, [row], row)).toBe(true);
  expect(program.items[0].id).toBe('B1111111111');
  expect(nativePlayingTrack(program, [row], { ...row, id: 'other', youtube_id: 'C1111111111' })).toBe(false);
  expect(nativePlayingTrack(null, [row], row)).toBe(false);
});
