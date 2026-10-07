import { expect, it } from 'vitest';
import { playlistNames } from './playlistOrder';
it('honours explicit order even for numeric names and drops stale duplicates', () => {
  expect(playlistNames({ '10': [], '2': [], Third: [] }, ['10', '2', '10', 'missing'])).toEqual(['10', '2', 'Third']);
  expect(playlistNames({ '10': [], '2': [] })).toEqual(['10', '2']);
});
