import { expect, it } from 'vitest';
import { musicLibraryRows } from './musicLibrary';
import type { Track } from '../types/music';
it('native and browser music browsing share saved/file promotion, recency and podcast exclusion', () => {
  const file: Track = { id: 'file', title: 'File', artist: 'Artist', added_at: '2026-01-01' };
  const saved: Track = { id: 'saved', title: 'Saved', artist: 'Artist', source: 'preview', added_at: '2026-02-01' };
  const podcast: Track = { id: 'episode', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' };
  expect(musicLibraryRows([file, podcast], [file, saved])).toEqual([saved, file]);
});
