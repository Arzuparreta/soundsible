import { describe, expect, it } from 'vitest';
import {
  savedFromCatalogItem,
  savedFromSearchResult,
  savedFromTrack,
  savedIsPlayable,
  savedToTrack,
  savedVideoId,
} from './saved';
import { buildIdentityIndex } from './playbackIdentity';
import type { CatalogItem, SavedEntry, SearchResult, Track } from '../types/music';

const VIDEO_ID = 'dQw4w9WgXcQ';

/** The song as the library holds it: id is a content hash, video id on the side. */
const ownedTrack: Track = {
  id: 'hash9f2a',
  title: 'Weightless',
  artist: 'Marconi Union',
  album: 'Ambient Transmissions',
  duration: 490,
  youtube_id: VIDEO_ID,
};

/** The same song as a YouTube search result: id *is* the video id. */
const searchResult: SearchResult = {
  id: VIDEO_ID,
  title: 'Weightless',
  channel: 'Marconi Union',
  duration: 490,
  thumbnail: 'https://example.invalid/thumb.jpg',
};

/** And as a Deezer row: no video id at all until something resolves it. */
const deezerRow: CatalogItem = {
  id: 'deezer:track:3135556',
  type: 'track',
  source: 'deezer',
  title: 'Weightless',
  artist: 'Marconi Union',
  album: 'Ambient Transmissions',
  duration: 490,
  cover: 'https://example.invalid/cover.jpg',
  external_ids: { deezer_id: '3135556' },
};

const EMPTY_LIBRARY = buildIdentityIndex([]);

describe('building a favourite', () => {
  it('keys a library track by both its library id and its video id', () => {
    const entry = savedFromTrack(ownedTrack);

    expect(entry.keys).toContain('lib:hash9f2a');
    expect(entry.keys).toContain(`yt:${VIDEO_ID}`);
    expect(entry.title).toBe('Weightless');
    expect(entry.duration).toBe(490);
  });

  it('snapshots a preview so it can be rendered without the library', () => {
    const preview: Track = {
      id: VIDEO_ID,
      title: 'Weightless',
      artist: 'Marconi Union',
      duration: 490,
      cover: 'https://example.invalid/thumb.jpg',
      source: 'preview',
    };

    const entry = savedFromTrack(preview);
    expect(entry.keys).toEqual([`yt:${VIDEO_ID}`]);
    expect(entry.thumbnail).toBe('https://example.invalid/thumb.jpg');
  });

  it('does not snapshot artwork for owned tracks — the engine serves it', () => {
    expect(savedFromTrack(ownedTrack).thumbnail).toBeUndefined();
  });

  it('keeps a catalog row identifiable even with no video id yet', () => {
    const entry = savedFromCatalogItem(deezerRow);

    expect(entry.keys).toContain('cat:deezer:track:3135556');
    expect(entry.keys).toContain('deezer:3135556');
    expect(savedVideoId(entry)).toBeNull();
    expect(entry.artist).toBe('Marconi Union');
  });

  it('takes the artist from a catalog row wherever the source put it', () => {
    const withSubtitle: CatalogItem = { ...deezerRow, artist: undefined, subtitle: 'Marconi Union' };
    expect(savedFromCatalogItem(withSubtitle).artist).toBe('Marconi Union');
  });

  it('drops a duration of zero rather than storing a falsehood', () => {
    expect(savedFromSearchResult({ ...searchResult, duration: 0 }).duration).toBeUndefined();
  });
});

describe('resolving a favourite back to something playable', () => {
  it('streams a saved song the library has never seen', () => {
    const entry = savedFromSearchResult(searchResult);
    const track = savedToTrack(entry, EMPTY_LIBRARY)!;

    expect(track.source).toBe('preview');
    // A preview's id *is* the video id — that is what /api/preview/stream wants.
    expect(track.id).toBe(VIDEO_ID);
    expect(track.cover).toBe('https://example.invalid/thumb.jpg');
    expect(savedIsPlayable(entry, track)).toBe(true);
  });

  /** The heart of the design: saving and downloading are independent, and the
   * entry follows the song across that boundary with nothing rewritten. */
  it('promotes the same entry to the owned track once it is downloaded', () => {
    const entry = savedFromSearchResult(searchResult);

    const before = savedToTrack(entry, EMPTY_LIBRARY)!;
    expect(before.source).toBe('preview');

    const after = savedToTrack(entry, buildIdentityIndex([ownedTrack]))!;
    expect(after).toBe(ownedTrack);
    expect(after.source).toBeUndefined();
    expect(after.id).toBe('hash9f2a');
  });

  it('promotes a Deezer row through the video it resolved to', () => {
    // Saved from a Deezer row, later widened with the video the engine matched.
    const entry: SavedEntry = {
      ...savedFromCatalogItem(deezerRow),
      keys: [...savedFromCatalogItem(deezerRow).keys, `yt:${VIDEO_ID}`],
    };

    expect(savedToTrack(entry, buildIdentityIndex([ownedTrack]))).toBe(ownedTrack);
  });

  it('degrades an owned favourite back to a preview when the file is deleted', () => {
    const entry = savedFromTrack({ ...ownedTrack, source: 'preview' });
    // Saved while owned, so it carries both keys and a snapshot.
    const saved: SavedEntry = { ...entry, keys: ['lib:hash9f2a', `yt:${VIDEO_ID}`] };

    const track = savedToTrack(saved, EMPTY_LIBRARY)!;
    expect(track.source).toBe('preview');
    expect(track.id).toBe(VIDEO_ID);
  });

  it('carries the saved identity so the row it came from still lights up', () => {
    const entry = savedFromCatalogItem(deezerRow);
    const track = savedToTrack({ ...entry, keys: [...entry.keys, `yt:${VIDEO_ID}`] }, EMPTY_LIBRARY)!;

    expect(track.originKeys).toContain('cat:deezer:track:3135556');
  });

  it('shows a saved song that has no source yet, but does not claim it is playable', () => {
    const entry = savedFromCatalogItem(deezerRow);
    const track = savedToTrack(entry, EMPTY_LIBRARY)!;

    expect(track.title).toBe('Weightless');
    expect(savedIsPlayable(entry, track)).toBe(false);
  });

  it('drops a pre-v2 entry whose track is gone — an id pointing at nothing', () => {
    expect(savedToTrack({ keys: ['lib:deleted'] }, EMPTY_LIBRARY)).toBeNull();
  });
});

describe('savedIsPlayable', () => {
  it('is true for anything owned, whatever keys the entry carries', () => {
    const entry: SavedEntry = { keys: ['deezer:3135556'], title: 'Weightless' };
    expect(savedIsPlayable(entry, ownedTrack)).toBe(true);
  });

  it('is false only while a saved song still has no source attached', () => {
    const entry = savedFromCatalogItem(deezerRow);
    expect(savedIsPlayable(entry, savedToTrack(entry, EMPTY_LIBRARY)!)).toBe(false);

    const widened: SavedEntry = { ...entry, keys: [...entry.keys, `yt:${VIDEO_ID}`] };
    expect(savedIsPlayable(widened, savedToTrack(widened, EMPTY_LIBRARY)!)).toBe(true);
  });
});
