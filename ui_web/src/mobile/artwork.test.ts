import { afterEach, expect, it } from 'vitest';
import { artworkUrl, setResourceOrigin } from '../lib/config';
import { coverUrl, trackCoverUrl } from '../lib/media';
afterEach(() => setResourceOrigin(null));
it('maps relative and selected-engine artwork to the generation-bound local proxy, keeping external URLs credential-free', () => {
  setResourceOrigin('https://localhost/__engine/7', 'https://music.example');
  expect(artworkUrl('/api/static/cover/a')).toBe('https://localhost/__engine/7/api/static/cover/a');
  expect(artworkUrl('https://music.example/api/static/cover/a?size=thumb')).toBe('https://localhost/__engine/7/api/static/cover/a?size=thumb');
  expect(artworkUrl('https://external.example/picture.jpg')).toBe('https://external.example/picture.jpg');
  expect(coverUrl('a', 'thumb')).toBe('https://localhost/__engine/7/api/static/cover/a?size=thumb');
  expect(trackCoverUrl({ id: 'saved', source: 'preview', cover: '/api/static/cover/saved' })).toBe('https://localhost/__engine/7/api/static/cover/saved');
  setResourceOrigin('https://localhost/__engine/8', 'https://second.example');
  expect(coverUrl('a', 'thumb')).toBe('https://localhost/__engine/8/api/static/cover/a?size=thumb');
});
