import { expect, it } from 'vitest';
import { programTrack } from './tracks';
import type { Track } from '../../types/music';
const episode = { id: 'episode-guid', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode', source: 'preview', podcast_enclosure_url: 'https://example.com/episode' } as Track;
it('distinguishes podcast proxy identity from preview video identity', () => {
  expect(programTrack(episode)).toMatchObject({ source: 'podcast', mediaKind: 'podcast_episode', enclosure: episode.podcast_enclosure_url, id: 'episode-guid' });
  expect(programTrack({ ...episode, source: undefined })).toMatchObject({ source: 'local', mediaKind: 'podcast_episode' });
});
it('refuses a missing or non-http enclosure before replacing a program', () => {
  expect(programTrack({ ...episode, podcast_enclosure_url: undefined })).toBeNull();
  expect(programTrack({ ...episode, podcast_enclosure_url: 'file:///private' })).toBeNull();
});
