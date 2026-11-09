import { describe, expect, it } from 'vitest';
import { podcastArtwork, podcastArtworkPath } from './podcastArtwork';

describe('podcast artwork', () => {
  it('is asked of the engine, never of the feed host', () => {
    const url = 'https://s1.staticld.com//2021/09/07/federico-podcast-2021.jpg';
    expect(podcastArtworkPath(url)).toBe(`/api/podcasts/artwork?url=${encodeURIComponent(url)}`);
    expect(podcastArtwork(url)).toBe(`${window.location.origin}/api/podcasts/artwork?url=${encodeURIComponent(url)}`);
  });

  it('leaves engine paths and missing artwork alone', () => {
    const path = '/api/podcasts/artwork?url=https%3A%2F%2Fx.example%2Fa.jpg';
    expect(podcastArtworkPath(path)).toBe(path);
    expect(podcastArtworkPath(null)).toBeUndefined();
    expect(podcastArtwork('')).toBeUndefined();
  });
});
