import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { albumPath, artistPath } from '../lib/artistRoute';
import { sameEntity, type SavedEntity } from '../lib/savedEntityIdentity';
import type { CatalogAlbum, CatalogArtist } from '../types/music';
import type { MenuAction } from '../components/ActionMenu';

export function albumBookmark(album: CatalogAlbum): SavedEntity {
  return { kind: 'album', name: album.title, artist: album.album_artist,
    destination: albumPath(album.title, album.album_artist, { view: 'library', albumId: album.id }) };
}
export function artistBookmark(artist: CatalogArtist): SavedEntity {
  return { kind: 'artist', name: artist.name,
    destination: artistPath(artist.name, { view: 'library', artistId: artist.id }) };
}
/** Explicit bookmark intent; it never saves or acquires any songs. */
export function nativeEntityMark(entry: SavedEntity, entries: () => SavedEntity[], current: () => boolean,
  refresh: () => Promise<void>, failed: () => void): MenuAction {
  const saved = entries().some(row => sameEntity(row, entry));
  let pending = false;
  return { label: t(saved ? 'savedEntities.remove' : 'savedEntities.save'), selected: saved, disabled: !current(),
    onSelect: () => {
      if (!current() || pending) return;
      pending = true;
      void (async () => {
        const reply = await request<{ entities: SavedEntity[] }>('/api/library/saved-entities', { method: 'PUT', body: { entry, saved: !saved }, timeoutMs: 15000 });
        if (!current()) return;
        if (!Array.isArray(reply.entities) || reply.entities.some(row => sameEntity(row, entry)) !== !saved) throw new Error('Missing bookmark confirmation');
        await refresh();
      })().catch(() => { if (current()) failed(); }).finally(() => { pending = false; });
    } };
}
