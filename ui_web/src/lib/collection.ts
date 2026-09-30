import { actions } from '../stores';
import type { CatalogItem, SavedEntry } from '../types/music';
import { api } from './api';
import { confirmDialog } from './confirm';
import { t } from './i18n';
import type { MigrationJob } from './migrationApi';
import { savedFromCatalogItem } from './saved';
import type { SavedEntity } from './savedEntities';

/** Bulk song actions are independent of album and artist bookmarks. */

/** Every song, as the entries saving it would add. */
export function songEntries(tracklist: CatalogItem[]): SavedEntry[] {
  return tracklist.map(savedFromCatalogItem);
}

/** The current download state, independent of the navigation bookmark. */
export type CollectionStep = 'download' | 'downloading' | 'review' | 'missing' | 'owned';

const RUNNING = new Set(['analyzed', 'queued', 'running']);

export const jobRunning = (job: MigrationJob | null | undefined): boolean => !!job && RUNNING.has(job.state);

export const jobReviewCount = (job: MigrationJob | null | undefined): number => job?.selected_counts?.needs_review ?? 0;

/** Songs the last pass could not get: no match was found, or the download failed. */
export const jobMissingCount = (job: MigrationJob | null | undefined): number =>
  (job?.selected_counts?.unavailable ?? 0) + (job?.selected_counts?.failed ?? 0);

export function collectionStep(opts: { total: number; owned: number; job: MigrationJob | null | undefined }): CollectionStep {
  if (opts.total > 0 && opts.owned >= opts.total) return 'owned';
  if (jobRunning(opts.job)) return 'downloading';
  if (jobReviewCount(opts.job) > 0) return 'review';
  // A song that failed is fetched again by ⬇; one never found is not.
  const unfound = opts.job?.selected_counts?.unavailable ?? 0;
  if (unfound > 0 && opts.total - opts.owned <= unfound) return 'missing';
  return 'download';
}

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
