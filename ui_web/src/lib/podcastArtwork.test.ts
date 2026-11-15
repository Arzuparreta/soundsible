import { describe, expect, it } from 'vitest';
import {
  isPodcastArtwork,
  podcastArtwork,
  podcastArtworkCandidates,
  podcastArtworkPath,
  sizedPodcastArtwork,
} from './podcastArtwork';

const FEED_IMAGE = 'https://s1.staticld.com//2021/09/07/federico-podcast-2021.jpg';
const PATH = `/api/podcasts/artwork?url=${encodeURIComponent(FEED_IMAGE)}`;

describe('podcast artwork', () => {
  it('is asked of the engine, never of the feed host', () => {
    expect(podcastArtworkPath(FEED_IMAGE)).toBe(PATH);
    expect(podcastArtwork(FEED_IMAGE, 160)).toBe(`${window.location.origin}${PATH}&size=160`);
  });

  it('leaves engine paths and missing artwork alone', () => {
    expect(podcastArtworkPath(PATH)).toBe(PATH);
    expect(podcastArtworkPath(null)).toBeUndefined();
    expect(podcastArtwork('', 160)).toBeUndefined();
  });

  it('asks for a size only of podcast artwork', () => {
    const absolute = `${window.location.origin}${PATH}`;
    expect(isPodcastArtwork(absolute)).toBe(true);
    expect(sizedPodcastArtwork(`${absolute}&size=1280`, 640, true)).toBe(`${absolute}&size=640&fit=square`);
    expect(sizedPodcastArtwork(`${absolute}&fit=square`, 160)).toBe(`${absolute}&size=160`);
    // The feed URL is a query value, so a host that happens to be named like
    // the route is not taken for it.
    const library = 'https://engine.example/api/static/cover/abc?size=thumb';
    expect(isPodcastArtwork(library)).toBe(false);
    expect(sizedPodcastArtwork(library, 160)).toBe(library);
    expect(sizedPodcastArtwork(undefined, 160)).toBeUndefined();
  });

  it('offers every size the engine draws to an <img>', () => {
    expect(podcastArtworkCandidates(PATH)).toBe([160, 320, 640, 960, 1280]
      .map((size) => `${PATH}&size=${size} ${size}w`).join(', '));
    expect(podcastArtworkCandidates('https://cdn.example.com/a.jpg')).toBeUndefined();
  });
});
