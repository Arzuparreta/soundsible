import { albumPath, artistPath } from './artistRoute';
import type { CatalogItem, Track } from '../types/music';
import type { SavedEntity } from './savedEntityIdentity';

/** Song holdings use exact entity identities; bookmarks never create holdings. */
export function catalogEntityHoldings(tracks: readonly Track[]): Set<string> {
  const keys = new Set<string>();
  for (const track of tracks) for (const kind of ['artist', 'album'] as const) {
    const local = track[`${kind}_id`], deezer = track[`deezer_${kind}_id`];
    if (local) keys.add(`${kind}:library:${local}`);
    if (deezer) keys.add(`${kind}:deezer:${deezer}`);
  }
  return keys;
}

function entityId(item: CatalogItem, key: string): string | undefined {
  const value = item.external_ids?.[key] ?? item.raw?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** An external entity keeps its provider id through navigation and bookmarks. */
export function catalogEntityDestination(item: CatalogItem): string | undefined {
  if (item.type !== 'artist' && item.type !== 'album') return;
  const kind = item.type, view = item.source === 'library' ? 'library' : 'discover';
  const deezerId = entityId(item, `deezer_${kind}_id`);
  if (kind === 'artist') return artistPath(item.title, { view, deezerId, artistId: entityId(item, 'artist_id') });
  return albumPath(item.title, item.raw?.album_artist || item.artist || item.subtitle || '', {
    view, deezerId, albumId: entityId(item, 'album_id'),
  });
}

export function catalogEntityBookmark(item: CatalogItem): SavedEntity | undefined {
  const destination = catalogEntityDestination(item);
  if (!destination || (item.type !== 'artist' && item.type !== 'album')) return;
  return { kind: item.type, name: item.title, artist: item.type === 'album' ? item.raw?.album_artist || item.artist || item.subtitle : undefined,
    cover: item.cover, destination };
}

export function catalogEntityHeld(item: CatalogItem, holdings: ReadonlySet<string>): boolean {
  if (item.action_state?.in_library || item.source === 'library') return true;
  if (item.type !== 'artist' && item.type !== 'album') return false;
  const external = entityId(item, `deezer_${item.type}_id`), local = entityId(item, `${item.type}_id`);
  return !!((external && holdings.has(`${item.type}:deezer:${external}`)) || (local && holdings.has(`${item.type}:library:${local}`)));
}

/** Stable preference, with ownership supplied by the current runtime. */
export function prioritizeCatalogItems<T>(items: readonly T[], known: (item: T) => boolean): T[] {
  const fresh: T[] = [], held: T[] = [];
  for (const item of items) (known(item) ? held : fresh).push(item);
  return [...fresh, ...held];
}
