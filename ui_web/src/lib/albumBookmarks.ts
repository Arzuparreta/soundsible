import { createSignal, onCleanup, onMount } from 'solid-js';
import { request } from './api';
import { userKey } from './session';
import { artistKey } from './artistRoute';

export interface AlbumBookmark {
  id?: string;
  title: string;
  artist: string;
  cover?: string;
  albumId?: string;
  deezerId?: string;
  view?: 'library' | 'discover';
}

export function sameAlbum(a: AlbumBookmark, b: AlbumBookmark): boolean {
  if (a.deezerId && b.deezerId) return a.deezerId === b.deezerId;
  if (a.albumId && b.albumId) return a.albumId === b.albumId;
  if (a.deezerId || b.deezerId || a.albumId || b.albumId) return false;
  return artistKey(a.title) === artistKey(b.title) && artistKey(a.artist) === artistKey(b.artist);
}

/** Each mounted view refreshes from the server; events synchronize mounted views. */
export function useAlbumBookmarks() {
  const [albums, setAlbums] = createSignal<AlbumBookmark[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  let generation = 0;
  let disposed = false;
  async function refresh() {
    const current = ++generation;
    const account = userKey('bookmarks');
    setLoading(true);
    try {
      const result = await request<{ albums: AlbumBookmark[] }>('/api/album-bookmarks');
      if (!disposed && current === generation && account === userKey('bookmarks')) {
        setAlbums(result.albums); setError(false);
      }
    } catch { if (!disposed && current === generation) setError(true); }
    finally { if (!disposed && current === generation) setLoading(false); }
  }
  const changed = () => { void refresh(); };
  onMount(() => {
    void refresh();
    window.addEventListener('album-bookmarks-changed', changed);
    window.addEventListener('focus', changed);
  });
  onCleanup(() => {
    disposed = true;
    window.removeEventListener('album-bookmarks-changed', changed);
    window.removeEventListener('focus', changed);
  });
  const find = (album: AlbumBookmark) => albums().find((entry) => sameAlbum(entry, album));
  async function toggle(album: AlbumBookmark) {
    if (pending() || loading() || error()) return;
    const existing = find(album);
    setPending(true);
    try {
      if (existing) await request(`/api/album-bookmarks/${encodeURIComponent(existing.id!)}`, { method: 'DELETE' });
      else await request('/api/album-bookmarks', { method: 'PUT', body: album });
      await refresh();
      window.dispatchEvent(new Event('album-bookmarks-changed'));
    } finally { setPending(false); }
  }
  return { albums, loading, error, pending, refresh, find, toggle };
}
