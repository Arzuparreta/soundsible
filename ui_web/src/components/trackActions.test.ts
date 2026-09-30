import { describe, it, expect } from 'vitest';
import { buildTrackMenu } from './trackActions';
import { albumMenuOptions } from './albumActions';
import { artistMenuOptions } from './artistActions';
import { playlistMenuOptions } from './playlistActions';
import type { Track } from '../types/music';

const labels = (track: Track, ctx = {}) => buildTrackMenu(track, ctx).map((a) => a.label);

const ctx = { onAddToPlaylist: () => {} };

describe('buildTrackMenu — podcast coherence', () => {
  const streamedEpisode: Track = {
    id: 'g1',
    title: 'Episode',
    artist: 'My Show',
    source: 'preview',
    media_kind: 'podcast_episode',
    podcast_episode_guid: 'g1',
  };

  it('streamed podcast episodes only expose share (no radio/queue/playlist/save/fav)', () => {
    const l = labels(streamedEpisode, ctx);
    expect(l).toContain('Share');
    expect(l).not.toContain('Start radio');
    expect(l).not.toContain('Add to playlist');
    expect(l).not.toContain('Play next');
    expect(l).not.toContain('Add to queue');
    expect(l).not.toContain('Save to your library');
    expect(l).not.toContain('Download');
    expect(l).not.toContain('Add to favourites');
  });

  it('downloaded podcast episodes can be queued but not put on radio/playlists', () => {
    const downloaded: Track = { id: 'd1', title: 'Episode', artist: 'My Show', media_kind: 'podcast_episode' };
    const l = labels(downloaded, ctx);
    expect(l).toContain('Play next');
    expect(l).toContain('Add to queue');
    expect(l).not.toContain('Start radio');
    expect(l).not.toContain('Add to playlist');
  });

  it('preview music tracks keep radio, and offer both halves of having a song', () => {
    const preview: Track = { id: 'yt1', title: 'Song', artist: 'A', source: 'preview' };
    const l = labels(preview, ctx);
    expect(l).toContain('Start radio');
    expect(l).toContain('Add to playlist');
    expect(l).toContain('Save to your library');
    expect(l).toContain('Download');
  });

  it('turns music actions into DJ-native actions while DJ owns the session', () => {
    const song: Track = { id: 'dj1', title: 'Song', artist: 'A', source: 'preview' };
    const l = labels(song, { ...ctx, auto: true });
    expect(l).toContain('Play now');
    expect(l).toContain('Add to route');
    expect(l).toContain('Mix into session');
    expect(l).not.toContain('Play next');
    expect(l).not.toContain('Add to queue');
  });

  it('keeps a DJ route occurrence to having the song, never to playing, placing or deleting it', () => {
    // The route owns where the song plays. Its row menu moves and drops it;
    // this half only offers what keeping it means.
    const found: Track = { id: 'dj2', title: 'Song', artist: 'A', album: 'Record', source: 'preview',
      recommendation: { identity: 'music:track:dj2', source: 'auto_mode', reason: 'Following the thread of Root' } };
    const l = labels(found, { ...ctx, inRoute: true });
    expect(l).toEqual(['Add to playlist', 'Go to artist', 'Go to album', 'Share',
      'Following the thread of Root', 'Not interested', 'Save to your library', 'Download']);

    // Deleting a file would strip the song out of the queue behind the route.
    const owned: Track = { id: 'lib3', title: 'Song', artist: 'A' };
    const o = labels(owned, { ...ctx, inRoute: true, onPlayOnDevice: () => {} });
    expect(o).toContain('Add to favourites');
    for (const label of ['Play now', 'Add to route', 'Mix into session', 'Start DJ from current song', 'Play next',
      'Add to queue', 'Start radio', 'Switch and start Radio', 'Play on device', 'Delete from library']) {
      expect(o).not.toContain(label);
    }
  });

  it('offers a contextual DJ start in both NORMAL and DJ song menus', () => {
    const song: Track = { id: 'song', title: 'Selected song', artist: 'A' };
    for (const context of [{}, { auto: true }]) {
      expect(labels(song, context)).toContain('Start DJ from current song');
      expect(labels(song, context)).not.toContain('Change session');
    }
    expect(labels({ ...song, media_kind: 'podcast_episode' }, { auto: true })).not.toContain('Start DJ from current song');
  });

  it('withholds the heart until a song is in the library, and offers saving instead', () => {
    // A search result the user has never claimed. Marking it out among "your
    // songs" would presuppose the thing the ＋ above it is there to do.
    const unsaved: Track = { id: 'yt2', title: 'Song', artist: 'A', source: 'preview' };
    const l = labels(unsaved, ctx);
    expect(l).not.toContain('Add to favourites');
    expect(l).toContain('Save to your library');
    // …and a downloaded song, which is in the library by definition, has it.
    const owned: Track = { id: 'lib1', title: 'Song', artist: 'A' };
    expect(labels(owned, ctx)).toContain('Add to favourites');
  });
});

describe('menu icons', () => {
  // A row without a glyph reads as a different kind of thing in a list where
  // every other row has one — the save and DJ rows used to be exactly that.
  const unlabelled = (actions: { icon?: unknown; label: string }[]) => actions.filter((a) => !a.icon).map((a) => a.label);
  const full = { ...ctx, onEditMetadata: () => {}, onPlayOnDevice: () => {}, playlistName: 'Mix', onRemoveFromPlaylist: () => {} };

  it('draws every track action, in and out of DJ', () => {
    const preview: Track = { id: 'yt3', title: 'Song', artist: 'A', album: 'Record', source: 'preview' };
    const owned: Track = { id: 'lib2', title: 'Song', artist: 'A', album: 'Record' };
    for (const track of [preview, owned]) {
      expect(unlabelled(buildTrackMenu(track, full))).toEqual([]);
      expect(unlabelled(buildTrackMenu(track, { ...full, auto: true }))).toEqual([]);
      expect(unlabelled(buildTrackMenu(track, { ...full, inRoute: true }))).toEqual([]);
    }
  });

  it('draws every album, artist and playlist action', () => {
    const album = { id: 'al1', title: 'Record', album_artist: 'A' } as Parameters<typeof albumMenuOptions>[0];
    expect(unlabelled(albumMenuOptions(album).actions ?? [])).toEqual([]);
    expect(unlabelled(artistMenuOptions('A').actions ?? [])).toEqual([]);
    expect(unlabelled(playlistMenuOptions('Mix', { onEdit: () => {} }).actions ?? [])).toEqual([]);
  });
});
