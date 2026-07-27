import { describe, expect, it } from 'vitest';
import {
  buildIdentityIndex,
  catalogItemKeys,
  collectIdentityKeys,
  keysMatch,
  podcastEpisodeKeys,
  resolvePlayingKeys,
  searchResultKeys,
  trackKeys,
  withLinkedKeys,
} from './playbackIdentity';
import type { CatalogItem, Track } from '../types/music';

const NO_LINKS = new Map<string, string>();

/** The Deezer row as the catalog search returns it: no video id, no library id. */
const deezerRow: CatalogItem = {
  id: 'deezer:track:12345',
  type: 'track',
  source: 'deezer',
  title: 'Song A',
  artist: 'Artist A',
  external_ids: { deezer_id: '12345' },
};

/** What playing that row produces: a preview keyed by the video it resolved to,
 * carrying the row's identity so the row can still recognise it. */
const preview: Track = {
  id: 'vid123',
  title: 'Song A',
  artist: 'Artist A',
  source: 'preview',
  originKeys: catalogItemKeys(deezerRow),
};

/** What downloading it produces: a library track with a content-hash id. */
const downloaded: Track = {
  id: 'sha256hash',
  title: 'Song A',
  artist: 'Artist A',
  youtube_id: 'vid123',
};

const playing = (current: Track | null, library: Track[] = [], links = NO_LINKS) =>
  resolvePlayingKeys(current, buildIdentityIndex(library), links);

describe('playback identity', () => {
  it('keeps a preview and its library twin apart in the id namespaces', () => {
    // A preview's id is a video id, never a library id — mixing the two would
    // have a preview claim to be a library track that does not exist.
    expect(trackKeys(preview)).toContain('yt:vid123');
    expect(trackKeys(preview)).not.toContain('lib:vid123');
    expect(trackKeys(downloaded)).toEqual(
      expect.arrayContaining(['lib:sha256hash', 'yt:vid123']),
    );
  });

  it('lights up the search row that started playback (no id in common)', () => {
    const keys = playing(preview);
    expect(keysMatch(catalogItemKeys(deezerRow), keys, NO_LINKS)).toBe(true);
  });

  it('keeps the row lit after the search is re-run and rows are rebuilt', () => {
    // Same song, freshly deserialized row object — matching must not depend on
    // object identity, only on the (stable) catalog id.
    const refetched: CatalogItem = { ...deezerRow };
    expect(keysMatch(catalogItemKeys(refetched), playing(preview), NO_LINKS)).toBe(true);
  });

  it('lights up the library row once the download lands mid-song', () => {
    // Before: the library does not have it, so only the preview answers.
    expect(keysMatch(trackKeys(downloaded), playing(preview), NO_LINKS)).toBe(true);
    // After syncLibrary(): the twin is found through `yt:`, and its library id
    // joins the playing set — which is what the library list compares against.
    const after = playing(preview, [downloaded]);
    expect(after.has('lib:sha256hash')).toBe(true);
  });

  it('lights up the search row and the library row at the same time', () => {
    const keys = playing(preview, [downloaded]);
    expect(keysMatch(catalogItemKeys(deezerRow), keys, NO_LINKS)).toBe(true);
    expect(keysMatch(trackKeys(downloaded), keys, NO_LINKS)).toBe(true);
  });

  it('finds the download behind a catalog row once the resolution is known', () => {
    const index = buildIdentityIndex([downloaded]);
    // The row and the download share nothing until the link is recorded…
    expect(catalogItemKeys(deezerRow).some((k) => index.has(k))).toBe(false);
    // …and everything after.
    const links = new Map([['deezer:track:12345', 'vid123']]);
    const linked = withLinkedKeys(catalogItemKeys(deezerRow), links);
    expect(linked.some((k) => index.has(k))).toBe(true);
  });

  it('matches an online result against the library copy it was downloaded as', () => {
    const result = { id: 'vid123', title: 'Song A', channel: 'Artist A' };
    const index = buildIdentityIndex([downloaded]);
    expect(searchResultKeys(result).some((k) => index.has(k))).toBe(true);
  });

  it('bridges catalogs through the ISRC, whatever its formatting', () => {
    const owned: Track = { ...downloaded, isrc: 'us-rc1-23-45678' };
    const row: CatalogItem = { ...deezerRow, external_ids: { isrc: 'USRC12345678' } };
    expect(keysMatch(catalogItemKeys(row), playing(owned), NO_LINKS)).toBe(true);
  });

  it('does not conflate different recordings of the same song', () => {
    // Same artist and title, no id in common: a live take, a remix, a re-record.
    const otherRecording: Track = { id: 'othervid', title: 'Song A', artist: 'Artist A', source: 'preview' };
    expect(keysMatch(trackKeys(otherRecording), playing(preview), NO_LINKS)).toBe(false);
    expect(keysMatch(catalogItemKeys(deezerRow), playing(otherRecording), NO_LINKS)).toBe(false);
  });

  it('answers "nothing is playing" without allocating a key set', () => {
    expect(playing(null).size).toBe(0);
    expect(keysMatch(trackKeys(downloaded), playing(null), NO_LINKS)).toBe(false);
  });

  it('tracks a podcast episode from stream to download', () => {
    const streamed: Track = {
      id: 'guid-1',
      title: 'Ep 1',
      artist: 'Show',
      source: 'preview',
      podcast_episode_guid: 'guid-1',
    };
    const saved: Track = {
      id: 'libep1',
      title: 'Ep 1',
      artist: 'Show',
      media_kind: 'podcast_episode',
      podcast_episode_guid: 'guid-1',
    };
    const keys = playing(streamed, [saved]);
    expect(keysMatch(podcastEpisodeKeys('guid-1'), keys, NO_LINKS)).toBe(true);
    expect(keys.has('lib:libep1')).toBe(true);
  });

  it('reports queue membership across sources', () => {
    const queued = collectIdentityKeys([downloaded]);
    // The Deezer row is in the queue as its downloaded twin — different id.
    const links = new Map([['deezer:track:12345', 'vid123']]);
    expect(keysMatch(catalogItemKeys(deezerRow), queued, links)).toBe(true);
    expect(keysMatch(catalogItemKeys(deezerRow), queued, NO_LINKS)).toBe(false);
  });

  it('keeps the first library entry when duplicates share an identity', () => {
    const dupe: Track = { ...downloaded, id: 'secondhash' };
    const index = buildIdentityIndex([downloaded, dupe]);
    expect(index.get('yt:vid123')?.id).toBe('sha256hash');
  });
});
