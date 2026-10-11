import { expect, it } from 'vitest';
import { canPlayOnDevice, remotePlayRequest } from './remotePlayback';

it('sends unresolved saved identities for matching at the destination without changing the sender', () => {
  const track = { id: 'deezer:42', title: 'Song', artist: 'A', source: 'preview' as const, originKeys: ['deezer:42'] };
  expect(remotePlayRequest(track)).toMatchObject({ track_id: track.id, track: { source: 'preview', originKeys: track.originKeys,
    pendingResolve: { catalogItemId: track.id, artist: 'A', title: 'Song' } } });
  expect(track).not.toHaveProperty('pendingResolve');
  expect(canPlayOnDevice({ ...track, artist: '' })).toBe(false);
});

it('never mistakes a native pending queue row for a library file', () => {
  const track = { id: 'pending:deezer:42', title: 'Song', artist: 'A', pendingResolve: { catalogItemId: 'deezer:42', artist: 'A', title: 'Song' } };
  expect(remotePlayRequest(track).track).toMatchObject({ source: 'preview', pendingResolve: track.pendingResolve });
});

it('keeps streamed episodes separate from catalogue video matching', () => {
  const track = { id: 'episode', title: 'Episode', artist: 'Show', source: 'preview' as const, media_kind: 'podcast_episode', podcast_enclosure_url: 'https://example.com/ep.mp3' };
  expect(canPlayOnDevice(track)).toBe(true);
  expect(remotePlayRequest(track).track).toEqual(track);
  expect(canPlayOnDevice({ ...track, podcast_enclosure_url: undefined })).toBe(false);
});
