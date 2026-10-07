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

it('keeps an unresolved catalogue identity in the native queue until playback', () => {
  const pending = { id: 'deezer:track:7', title: 'Song', artist: 'Artist', pendingResolve: { catalogItemId: 'deezer:track:7', title: 'Song', artist: 'Artist' } };
  expect(programTrack(pending)).toMatchObject({ source: 'pending', id: pending.id, pendingResolve: pending.pendingResolve });
  const invalid = { ...pending, pendingResolve: { ...pending.pendingResolve, title: '' } };
  expect(programTrack(invalid)).toBeNull();
});
