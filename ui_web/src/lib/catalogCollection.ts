import { createMemo, createRoot } from 'solid-js';
import { isSavedItem, musicLibrary } from '../stores';
import type { CatalogItem } from '../types/music';
import { catalogDestination } from './musicNavigation';
import { isEntitySaved, type SavedEntity } from './savedEntities';
import { t } from './i18n';

// Membership comes from song holdings and exact entity ids, never from a bookmark
// or a title match (two editions and two namesakes remain distinct).
const heldEntities = createRoot(() => createMemo(() => {
  const keys = new Set<string>();
  for (const track of musicLibrary()) {
    for (const kind of ['artist', 'album'] as const) {
      const local = track[`${kind}_id`];
      const deezer = track[`deezer_${kind}_id`];
      if (local) keys.add(`${kind}:library:${local}`);
      if (deezer) keys.add(`${kind}:deezer:${deezer}`);
    }
  }
  return keys;
}));

export function catalogSavedEntity(item: CatalogItem): SavedEntity | undefined {
  if (item.type !== 'artist' && item.type !== 'album') return;
  const destination = catalogDestination(item);
  if (!destination) return;
  return { kind: item.type, name: item.title, artist: item.type === 'album' ? item.artist || item.subtitle : undefined, cover: item.cover, destination };
}

export function catalogInLibrary(item: CatalogItem): boolean {
  if (item.action_state?.in_library || item.source === 'library') return true;
  if (item.type === 'track' || item.type === 'library_track') return isSavedItem(item);
  if (item.type !== 'album' && item.type !== 'artist') return false;
  const external = item.external_ids?.[`deezer_${item.type}_id`];
  const local = item.raw?.[`${item.type}_id`];
  return !!((external && heldEntities().has(`${item.type}:deezer:${external}`)) ||
    (local && heldEntities().has(`${item.type}:library:${local}`)));
}

export function catalogIsBookmarked(item: CatalogItem): boolean {
  const entry = catalogSavedEntity(item);
  return !!entry && isEntitySaved(entry);
}

export function catalogCollectionLabel(item: CatalogItem): string {
  return [catalogIsBookmarked(item) ? t('savedEntities.saved') : '',
    catalogInLibrary(item) ? t('savedEntities.inLibrary') : ''].filter(Boolean).join(' · ');
}

/** Stable preference for music not yet held or bookmarked; nothing is hidden. */
export function prioritizeDiscoveries<T extends CatalogItem>(items: readonly T[]): T[] {
  const fresh: T[] = [], known: T[] = [];
  for (const item of items) (catalogInLibrary(item) || catalogIsBookmarked(item) ? known : fresh).push(item);
  return [...fresh, ...known];
}
