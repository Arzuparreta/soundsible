import { describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({ apiOrigin: () => '' }));

const { previewUrl, streamUrl, podcastStreamUrl, coverUrl, trackCoverUrl, hasCoverArt } =
  await import('./media');

/**
 * A media URL is the browser's cache key.
 *
 * These look like tautologies and are not. Tagging each play with its own
 * attempt id — done so server and client telemetry could be joined on it —
 * handed the browser a key it had never seen every single time, so it re-fetched
 * music it already had, in full, on every play. On a LAN that is invisible; over
 * a remote link it is seconds of spinner before a downloaded song starts. The
 * engine already answers a conditional request with a 304 in about a
 * millisecond, and none of that can help while the URL keeps changing.
 */
describe('media URLs are cacheable', () => {
  it('gives a library track the same URL every time it is played', () => {
    expect(streamUrl('t1')).toBe(streamUrl('t1'));
    expect(streamUrl('t1')).toBe('/api/static/stream/t1');
  });

  it('gives a preview the same URL every time it is played', () => {
    expect(previewUrl('vid')).toBe(previewUrl('vid'));
    expect(previewUrl('vid')).toBe('/api/preview/stream/vid');
  });

  it('carries no query string at all', () => {
    // Anything per-play belongs in the telemetry body, never in the URL. A
    // query string here is not automatically wrong, but it is how this broke,
    // so it has to be a deliberate change rather than an accidental one.
    for (const url of [streamUrl('t1'), previewUrl('vid'), podcastStreamUrl('tok')]) {
      expect(url).not.toContain('?');
    }
  });

  it('takes an identity and nothing else', () => {
    // The signature is the guard. A second parameter here is how a per-play
    // token got into the URL last time: every caller kept compiling, every test
    // that built a URL from an id alone kept passing, and the only thing that
    // changed was that the browser stopped being able to reuse anything.
    expect(streamUrl).toHaveLength(1);
    expect(previewUrl).toHaveLength(1);
    expect(podcastStreamUrl).toHaveLength(1);
  });

  it('still escapes an id that would otherwise change the path', () => {
    expect(streamUrl('a/../b')).toBe('/api/static/stream/a%2F..%2Fb');
    expect(podcastStreamUrl('a b')).toBe('/api/podcasts/stream/a%20b');
  });
});

/**
 * A song you saved without downloading is not a track the engine has a row
 * for, so `/api/static/cover/<its id>` is a question about nothing. Its only
 * artwork is the thumbnail in its saved snapshot. Getting this fork wrong is
 * what left a playlist opening on such a song with a blank cover.
 */
describe('track artwork comes from wherever that track keeps it', () => {
  const owned = { id: 't1' };
  const saved = { id: 'vid', source: 'preview' as const, cover: 'https://img.youtube.com/vi/vid/mqdefault.jpg' };
  const savedNoArt = { id: 'vid2', source: 'preview' as const };
  const savedBlankArt = { id: 'vid3', source: 'preview' as const, cover: '' };

  it('asks the engine for a library track, at the size the caller wanted', () => {
    expect(trackCoverUrl(owned, 'thumb')).toBe(coverUrl('t1', 'thumb'));
    expect(trackCoverUrl(owned, 'thumb')).toContain('size=thumb');
    expect(trackCoverUrl(owned)).toBe(coverUrl('t1'));
    expect(trackCoverUrl(owned)).not.toContain('size=');
  });

  it('never asks the engine about a preview, whatever size is requested', () => {
    for (const url of [trackCoverUrl(saved), trackCoverUrl(saved, 'thumb')]) {
      expect(url).toBe(saved.cover);
      expect(url).not.toContain('/api/static/cover');
    }
  });

  it('says a preview with no thumbnail has nothing, rather than inventing a URL', () => {
    expect(trackCoverUrl(savedNoArt)).toBeUndefined();
    expect(trackCoverUrl(savedBlankArt)).toBeUndefined();
  });

  it('keeps `hasCoverArt` and `trackCoverUrl` answering the same question', () => {
    // The pair exists so the rule is written once. Two implementations of
    // "does this have art?" is exactly the drift that caused the bug.
    for (const track of [owned, saved, savedNoArt, savedBlankArt]) {
      expect(hasCoverArt(track)).toBe(trackCoverUrl(track) !== undefined);
    }
  });
});
