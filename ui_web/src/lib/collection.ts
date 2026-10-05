import { actions } from '../stores';
import type { CatalogItem, SavedEntry } from '../types/music';
import { api } from './api';
import { confirmDialog } from './confirm';
import { t } from './i18n';
import { savedFromCatalogItem } from './saved';
import type { SavedEntity } from './savedEntities';

/** Bulk song actions are independent of album and artist bookmarks. */

/** Every song, as the entries saving it would add. */
export function songEntries(tracklist: CatalogItem[]): SavedEntry[] {
  return tracklist.map(savedFromCatalogItem);
}

export { collectionStep, jobRunning, jobReviewCount, jobMissingCount, type CollectionStep } from './collectionState';

/** Adding a collection affects Songs only, never its navigation bookmark. */
export async function saveCollection(entity: SavedEntity, tracklist: CatalogItem[]): Promise<void> {
  if (tracklist.length === 0) return;
  const ok = await confirmDialog({
    title: t('collectionControl.addSongsTitle', { title: entity.name }),
    message: t('collectionControl.addSongsMessage', { n: tracklist.length }),
    confirmLabel: t('collectionControl.addSongs'),
  });
  if (ok) await actions.setSongsSaved(songEntries(tracklist), true);
}

/** An artist's albums, singles and EPs as one list of songs, each once, or
 * nothing when the artist cannot be read. */
export async function discographyOf(deezerId: string): Promise<CatalogItem[]> {
  try {
    const discography = await api.getArtistDiscography(deezerId);
    return Array.isArray(discography.tracklist) ? discography.tracklist : [];
  } catch {
    return [];
  }
}
