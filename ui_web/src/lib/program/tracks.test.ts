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

it('hands the native queue the record and the place on it, and nothing that is not one', () => {
  const song = { id: 'AbCdEfGhIjK', title: 'Song', artist: 'Artist', album: 'Album', source: 'preview' } as Track;
  expect(programTrack({ ...song, album_artist: 'Artist', track_number: 3, disc_number: 1, year: 2001 }))
    .toMatchObject({ album_artist: 'Artist', track_number: 3, disc_number: 1, year: 2001 });
  expect(programTrack({ ...song, track_number: 0, disc_number: 1.5, year: 20101012 }))
    .toMatchObject({ track_number: undefined, disc_number: undefined, year: undefined });
});
