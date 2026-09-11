import { fireEvent, render } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { CoverImage } from './CoverImage';
import { artworkCandidates, coverUrl, registerArtworkMetadata, trackCoverUrl } from '../lib/media';
vi.mock('../lib/config', () => ({ apiOrigin: () => '' }));

describe('responsive artwork', () => {
  it('offers density variants and caps at real cropped resolution', () => {
    registerArtworkMetadata([{ id: 'song', artwork_revision: 'original-1', artwork_width: 1280, artwork_height: 720 }]);
    const candidates = artworkCandidates(coverUrl('song'))!;
    expect(candidates).toContain('160w');
    expect(candidates).toContain('320w');
    expect(candidates).toContain('640w');
    expect(candidates).toContain('720w');
    expect(candidates).not.toContain('960w');
    expect(candidates).toContain('rev=original-1');
    expect(candidates).toContain('fit=square');
  });
  it('uses the library master even if playback carries an obsolete thumbnail', () => {
    expect(trackCoverUrl({ id: 'owned', cover: 'https://example.com/low.jpg' })).toContain('/api/static/cover/owned');
    expect(trackCoverUrl({ id: 'preview', source: 'preview', cover: 'https://example.com/low.jpg' })).toBe('https://example.com/low.jpg');
  });
  it('loads active artwork immediately and retries a failed image after change', () => {
    const [src, setSrc] = createSignal('/api/static/cover/one');
    const { container } = render(() => <div><CoverImage src={src()} eager /></div>);
    expect(container.querySelector('img')!.getAttribute('loading')).toBe('eager');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    setSrc('/api/static/cover/two');
    expect(container.querySelector('img')!.src).toContain('/cover/two');
  });
  it('does not invent variants for external images', () => {
    expect(artworkCandidates('https://example.com/image.jpg')).toBeUndefined();
    const { container } = render(() => <div><CoverImage src="https://example.com/image.jpg" /></div>);
    expect(container.querySelector('img')!.getAttribute('srcset')).toBeNull();
    expect(container.querySelector('img')!.getAttribute('loading')).toBe('lazy');
  });
});
