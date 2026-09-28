import { describe, expect, it } from 'vitest';
import { sameAlbum } from './albumBookmarks';

describe('album bookmark identity', () => {
  const album = { title: 'Álbum', artist: 'Band' };
  it('normalizes spelling without confusing artists', () => {
    expect(sameAlbum(album, { title: 'A\u0301LBUM', artist: ' band ' })).toBe(true);
    expect(sameAlbum(album, { ...album, artist: 'Other' })).toBe(false);
  });
  it('keeps editions distinct and accepts changed display metadata for the same ID', () => {
    expect(sameAlbum({ ...album, deezerId: '1' }, { ...album, deezerId: '2' })).toBe(false);
    expect(sameAlbum({ ...album, albumId: '1' }, { ...album, title: 'Changed', albumId: '1' })).toBe(true);
    expect(sameAlbum({ ...album, albumId: '1' }, album)).toBe(false);
  });
});
