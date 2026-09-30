import { actions, savedEntryForKeys } from '../stores';
import type { CatalogItem, SavedEntry } from '../types/music';
import { api } from './api';
import { confirmDialog } from './confirm';
import { t } from './i18n';
import type { MigrationJob } from './migrationApi';
import { savedFromCatalogItem } from './saved';
import { isEntitySaved, setEntitySaved, type SavedEntity } from './savedEntities';
import { toast } from './toast';

/**
 * An album in your library is one fact, the way a song is: saving it keeps the
 * record where you can find it (Library › Saved albums) and puts its songs in
 * your library, streaming until they are downloaded. Downloading it is the next
 * step, as ⬇ is for a song, and runs on the engine one song at a time.
 */

/** Every song on the record, as the entries saving it would add. */
export function albumSongEntries(tracklist: CatalogItem[]): SavedEntry[] {
  return tracklist.map(savedFromCatalogItem);
}

/** What the album offers next: ＋ → ⬇ → (downloading, or choosing versions) → ✓,
 * or, when all that is left was never found, which songs those are. */
export type AlbumStep = 'save' | 'download' | 'downloading' | 'review' | 'missing' | 'owned';

const RUNNING = new Set(['analyzed', 'queued', 'running']);

export const jobRunning = (job: MigrationJob | null | undefined): boolean => !!job && RUNNING.has(job.state);

export const jobReviewCount = (job: MigrationJob | null | undefined): number => job?.selected_counts?.needs_review ?? 0;

/** Songs the last pass could not get: no match was found, or the download failed. */
export const jobMissingCount = (job: MigrationJob | null | undefined): number =>
  (job?.selected_counts?.unavailable ?? 0) + (job?.selected_counts?.failed ?? 0);

export function albumStep(opts: { saved: boolean; total: number; owned: number; job: MigrationJob | null | undefined }): AlbumStep {
  if (!opts.saved) return 'save';
  if (opts.total > 0 && opts.owned >= opts.total) return 'owned';
  if (jobRunning(opts.job)) return 'downloading';
  if (jobReviewCount(opts.job) > 0) return 'review';
  // A song that failed is fetched again by ⬇; one never found is not.
  const unfound = opts.job?.selected_counts?.unavailable ?? 0;
  if (unfound > 0 && opts.total - opts.owned <= unfound) return 'missing';
  return 'download';
}

/** Songs on the record that taking it out would take out of the library too:
 * saved and streaming. A marked song and a downloaded one stay. */
export function removableSongs(entries: SavedEntry[]): number {
  return entries.filter((entry) => {
    const held = savedEntryForKeys(entry.keys);
    return !!held && !held.favourite && !held.keys.some((key) => key.startsWith('lib:'));
  }).length;
}

export async function saveAlbum(entity: SavedEntity, tracklist: CatalogItem[]): Promise<void> {
  await setEntitySaved(entity, true);
  if (!isEntitySaved(entity)) return;
  await actions.setSongsSaved(albumSongEntries(tracklist), true);
}

export async function unsaveAlbum(entity: SavedEntity, tracklist: CatalogItem[]): Promise<void> {
  const entries = albumSongEntries(tracklist);
  const leaving = removableSongs(entries);
  if (leaving > 0) {
    const ok = await confirmDialog({
      title: t('albumCollection.unsaveTitle', { title: entity.name }),
      message: t('albumCollection.unsaveMessage', { n: leaving }),
      confirmLabel: t('albumCollection.unsaveConfirm'),
      danger: true,
    });
    if (!ok) return;
  }
  await setEntitySaved(entity, false, { quiet: true });
  if (isEntitySaved(entity)) return;
  await actions.setSongsSaved(entries, false);
  toast.action(t('savedEntities.removed'), t('savedEntities.undo'), () => void saveAlbum(entity, tracklist));
}

/** The songs of an album known only by its link — a card, a saved-albums row.
 * A library album holds files already, so there is nothing to save for it. */
export async function albumTracklistFor(entity: SavedEntity): Promise<CatalogItem[]> {
  const params = new URLSearchParams(entity.destination.split('?')[1] ?? '');
  if (params.get('album_id') && !params.get('deezer_id')) return [];
  try {
    const profile = await api.getAlbumProfile(entity.name, entity.artist ?? params.get('artist') ?? '', params.get('deezer_id') ?? undefined);
    return profile.resolved ? profile.tracklist : [];
  } catch {
    return [];
  }
}

/** Save or take out an album known only by its link, the way its page would. */
export async function toggleAlbumFromLink(entity: SavedEntity): Promise<void> {
  if (isEntitySaved(entity)) {
    await unsaveAlbum(entity, await albumTracklistFor(entity));
    return;
  }
  // The bookmark answers at once; its songs follow once the record is read.
  await setEntitySaved(entity, true);
  if (!isEntitySaved(entity)) return;
  await actions.setSongsSaved(albumSongEntries(await albumTracklistFor(entity)), true);
}
