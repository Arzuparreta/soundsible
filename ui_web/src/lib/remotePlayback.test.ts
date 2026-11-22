import { expect, it, vi } from 'vitest';
vi.mock('./i18n', () => ({ t: (key: string, params?: Record<string, string>) => params ? `${key}:${params.device}` : key }));
import { canPlayOnDevice, remoteCommandMessage, remotePlayTracksArgs } from './remotePlayback';

it('sends unresolved saved identities for matching at the destination without changing the sender', () => {
  const track = { id: 'deezer:42', title: 'Song', artist: 'A', source: 'preview' as const, originKeys: ['deezer:42'] };
  expect(remotePlayTracksArgs(track)).toMatchObject({
    index: 0,
    tracks: [{ source: 'preview', originKeys: track.originKeys,
      pendingResolve: { catalogItemId: track.id, artist: 'A', title: 'Song' } }],
  });
  expect(track).not.toHaveProperty('pendingResolve');
  expect(canPlayOnDevice({ ...track, artist: '' })).toBe(false);
});

it('never mistakes a native pending queue row for a library file', () => {
  const track = { id: 'pending:deezer:42', title: 'Song', artist: 'A', pendingResolve: { catalogItemId: 'deezer:42', artist: 'A', title: 'Song' } };
  expect(remotePlayTracksArgs(track).tracks[0]).toMatchObject({ source: 'preview', pendingResolve: track.pendingResolve });
});

it('keeps streamed episodes separate from catalogue video matching', () => {
  const track = { id: 'episode', title: 'Episode', artist: 'Show', source: 'preview' as const, media_kind: 'podcast_episode', podcast_enclosure_url: 'https://example.com/ep.mp3' };
  expect(canPlayOnDevice(track)).toBe(true);
  expect(remotePlayTracksArgs(track)).toEqual({ tracks: [track], index: 0 });
  expect(canPlayOnDevice({ ...track, podcast_enclosure_url: undefined })).toBe(false);
});

it('maps every non-applied contract answer to its message with the target device name', () => {
  expect(remoteCommandMessage({ status: 'unreachable', reason: 'offline' }, 'Speaker')).toBe('deviceSheet.offline:Speaker');
  expect(remoteCommandMessage({ status: 'unreachable', reason: 'timeout' }, 'Speaker')).toBe('deviceSheet.timeout:Speaker');
  expect(remoteCommandMessage({ status: 'rejected', reason: 'update_required' }, 'Speaker')).toBe('deviceSheet.updateRequired:Speaker');
  expect(remoteCommandMessage({ status: 'rejected', reason: 'unsupported' }, 'Speaker')).toBe('deviceSheet.unsupported:Speaker');
  expect(remoteCommandMessage({ status: 'rejected', reason: 'needs_gesture' }, 'Speaker')).toBe('deviceSheet.needsGesture:Speaker');
  expect(remoteCommandMessage({ status: 'rejected', reason: 'nothing_playing' }, 'Speaker')).toBe('deviceSheet.nothingPlaying:Speaker');
  expect(remoteCommandMessage({ status: 'rejected', reason: 'invalid_state' }, 'Speaker')).toBe('deviceSheet.failed:Speaker');
  expect(remoteCommandMessage(null, 'Speaker')).toBe('deviceSheet.failed:Speaker');
});
