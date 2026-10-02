import { expect, it } from 'vitest';
import { localProgram } from './playback';
import type { Track } from '../types/music';
it('preserves local order and occurrence index without promoting saved previews', () => {
  const one = { id: 'one', title: 'one' } as Track;
  const preview = { id: 'saved', source: 'preview' } as Track;
  const anotherOccurrence = one;
  const queue = localProgram([preview, one, anotherOccurrence], 2);
  expect(queue.tracks).toEqual([one, anotherOccurrence]);
  expect(queue.index).toBe(1);
  expect(localProgram([preview, one], 0).index).toBe(-1);
});
