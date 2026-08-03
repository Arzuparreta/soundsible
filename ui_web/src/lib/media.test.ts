import { describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({ apiOrigin: () => '' }));

const { previewUrl, streamUrl, podcastStreamUrl } = await import('./media');

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
