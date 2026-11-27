import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { albumTvHash, createTvRouter, parseTvHash, playlistTvHash } from './router';

describe('TV hash router', () => {
  it('parses root, album, and playlist hashes including unicode titles', () => {
    expect(parseTvHash('')).toEqual({ name: 'home', hash: '#/home' });
    expect(parseTvHash('#/search').name).toBe('search');
    const albumHash = albumTvHash({ id: 'alb-1', name: 'Café Bleu', artist: 'The Style Council', deezerId: '42' });
    const album = parseTvHash(albumHash);
    expect(album).toMatchObject({
      name: 'album',
      albumId: 'alb-1',
      albumName: 'Café Bleu',
      artist: 'The Style Council',
      deezerId: '42',
      source: 'library',
    });

    const catalogAlbumHash = albumTvHash({
      id: 'deezer:album:42',
      name: 'Discovery',
      artist: 'Daft Punk',
      deezerId: '42',
      source: 'catalog',
    });
    expect(parseTvHash(catalogAlbumHash)).toMatchObject({
      name: 'album',
      albumId: 'deezer:album:42',
      albumName: 'Discovery',
      artist: 'Daft Punk',
      deezerId: '42',
      source: 'catalog',
    });

    const plHash = playlistTvHash('Night Drive 100%');
    expect(parseTvHash(plHash)).toMatchObject({
      name: 'playlist',
      playlistName: 'Night Drive 100%',
    });
  });

  it('preserves and pops focused item and scroll snapshots cleanly', () => {
    createRoot((dispose) => {
      const router = createTvRouter('#/home');
      expect(router.canPopOrReturnHome()).toBe(false);

      router.push(albumTvHash({ id: 'alb-2', name: 'Kid A' }), {
        focusedId: 'home-recent-2',
        scrollTop: 320,
        shelfScrolls: { 'home-recent': 180 },
      });
      expect(router.route().name).toBe('album');
      expect(router.canPopOrReturnHome()).toBe(true);

      const restored = router.pop();
      expect(restored).toEqual({
        hash: '#/home',
        focusedId: 'home-recent-2',
        scrollTop: 320,
        shelfScrolls: { 'home-recent': 180 },
      });
      expect(router.route().name).toBe('home');
      expect(router.pop()).toBeNull();
      dispose();
    });
  });
});
