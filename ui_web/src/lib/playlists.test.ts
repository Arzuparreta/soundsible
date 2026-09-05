import { describe, it, expect, vi } from 'vitest';
import type { LibrarySettings, Track } from '../types/music';

vi.mock('./config', () => ({ apiOrigin: () => '' }));

const { pickPlaylistCoverTrack } = await import('./playlists');

/** A downloaded song: the engine answers for its id. */
const lib = (id: string): Track => ({ id, title: id, artist: 'A' });

/** A song saved but never downloaded. It resolves in the library index just
 * like any other, and its only artwork is the thumbnail it carries. */
const preview = (id: string, cover?: string): Track =>
  ({ id, title: id, artist: 'A', source: 'preview', cover });

const index = (...tracks: Track[]) => new Map(tracks.map((track) => [track.id, track] as const));
const noSettings: LibrarySettings = {};
const prefer = (name: string, id: string): LibrarySettings => ({ playlist_covers: { [name]: id } });

describe('pickPlaylistCoverTrack walks to artwork, not to the first resolvable id', () => {
  /**
   * The reported bug, with its real data. "techno tracks for session" opens on
   * a song saved from YouTube and never downloaded (`95dB-ObZ7Ho`, "Move feat.
   * Malachiii"). It resolves — it is in the saved collection — but the engine
   * has no row for that id, so the grid asked `/api/static/cover/95dB-ObZ7Ho`,
   * got a 404 and drew an empty card while every other song in the playlist
   * had art. The song does have artwork; it just lives on its own thumbnail.
   */
  it('uses a saved-only song’s own thumbnail rather than asking the engine for it', () => {
    const thumb = 'https://img.youtube.com/vi/95dB-ObZ7Ho/mqdefault.jpg';
    const saved = preview('95dB-ObZ7Ho', thumb);
    const chosen = pickPlaylistCoverTrack(
      'techno tracks for session',
      ['95dB-ObZ7Ho', 'hash-2'],
      index(saved, lib('hash-2')),
      noSettings,
    );
    expect(chosen).toBe(saved);
    expect(chosen?.cover).toBe(thumb);
  });

  it('walks past a track that resolves but has no artwork at all', () => {
    // The old rule stopped here and returned an unshowable track.
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['no-art', 'owned'],
      index(preview('no-art'), lib('owned')),
      noSettings,
    );
    expect(chosen?.id).toBe('owned');
  });

  it('treats an empty thumbnail as no artwork', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['blank', 'owned'],
      index(preview('blank', ''), lib('owned')),
      noSettings,
    );
    expect(chosen?.id).toBe('owned');
  });

  it('skips an id the library has never heard of', () => {
    const chosen = pickPlaylistCoverTrack('mix', ['ghost', 'owned'], index(lib('owned')), noSettings);
    expect(chosen?.id).toBe('owned');
  });

  it('returns null only when nothing in the playlist can be drawn', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['a', 'b'],
      index(preview('a'), preview('b')),
      noSettings,
    );
    expect(chosen).toBeNull();
  });

  it('returns null for an empty playlist and for an empty library', () => {
    expect(pickPlaylistCoverTrack('mix', [], index(lib('owned')), noSettings)).toBeNull();
    expect(pickPlaylistCoverTrack('mix', ['owned'], index(), noSettings)).toBeNull();
  });
});

describe('a cover you picked by hand outranks the walk', () => {
  it('uses the preferred track even when it is not first', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['first', 'picked'],
      index(lib('first'), lib('picked')),
      prefer('mix', 'picked'),
    );
    expect(chosen?.id).toBe('picked');
  });

  /**
   * A deliberate choice about this playlist beats an automatic one, so it is
   * honoured even where the walk would have skipped it. Clearing the cover
   * (the picker's "auto") is how you ask for the walk back.
   */
  it('honours the preference even when that track has no artwork', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['no-art', 'owned'],
      index(preview('no-art'), lib('owned')),
      prefer('mix', 'no-art'),
    );
    expect(chosen?.id).toBe('no-art');
  });

  it('ignores a preference naming a track that is no longer in the playlist', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['owned'],
      index(lib('owned'), lib('elsewhere')),
      prefer('mix', 'elsewhere'),
    );
    expect(chosen?.id).toBe('owned');
  });

  it('ignores a preference naming a track the library cannot resolve', () => {
    const chosen = pickPlaylistCoverTrack(
      'mix',
      ['ghost', 'owned'],
      index(lib('owned')),
      prefer('mix', 'ghost'),
    );
    expect(chosen?.id).toBe('owned');
  });
});
