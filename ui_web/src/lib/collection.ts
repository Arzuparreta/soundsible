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
 * An album or an artist in your library is one fact, the way a song is: saving
 * it keeps the record or the artist where you can find it (Library › Saved)
 * and puts its songs in your library, streaming until they are downloaded.
 * Downloading them is the next step, as ⬇ is for a song, and runs on the
 * engine one song at a time. An artist's songs are their albums, singles and
 * EPs, each song once.
 */

/** Every song, as the entries saving it would add. */
export function songEntries(tracklist: CatalogItem[]): SavedEntry[] {
  return tracklist.map(savedFromCatalogItem);
}

/** What the collection offers next: ＋ → ⬇ → (downloading, or choosing
 * versions) → ✓, or, when all that is left was never found, which songs. */
export type CollectionStep = 'save' | 'download' | 'downloading' | 'review' | 'missing' | 'owned';

const RUNNING = new Set(['analyzed', 'queued', 'running']);

export const jobRunning = (job: MigrationJob | null | undefined): boolean => !!job && RUNNING.has(job.state);

export const jobReviewCount = (job: MigrationJob | null | undefined): number => job?.selected_counts?.needs_review ?? 0;

/** Songs the last pass could not get: no match was found, or the download failed. */
export const jobMissingCount = (job: MigrationJob | null | undefined): number =>
  (job?.selected_counts?.unavailable ?? 0) + (job?.selected_counts?.failed ?? 0);

export function collectionStep(opts: { saved: boolean; total: number; owned: number; job: MigrationJob | null | undefined }): CollectionStep {
  if (!opts.saved) return 'save';
  if (opts.total > 0 && opts.owned >= opts.total) return 'owned';
  if (jobRunning(opts.job)) return 'downloading';
  if (jobReviewCount(opts.job) > 0) return 'review';
  // A song that failed is fetched again by ⬇; one never found is not.
  const unfound = opts.job?.selected_counts?.unavailable ?? 0;
  if (unfound > 0 && opts.total - opts.owned <= unfound) return 'missing';
  return 'download';
}

/** Songs that taking the collection out would take out of the library too:
 * saved and streaming. A marked song and a downloaded one stay. */
export function removableSongs(entries: SavedEntry[]): number {
  return entries.filter((entry) => {
    const held = savedEntryForKeys(entry.keys);
    return !!held && !held.favourite && !held.keys.some((key) => key.startsWith('lib:'));
  }).length;
}

/** An artist's catalogue is not a click's worth of songs: saying how many
 * before they arrive is what makes one click safe. An album is its songs. */
async function confirmSaving(entity: SavedEntity, tracklist: CatalogItem[]): Promise<boolean> {
  if (entity.kind !== 'artist' || tracklist.length === 0) return true;
  return confirmDialog({
    title: t('collectionControl.saveArtistTitle', { title: entity.name }),
    message: t('collectionControl.saveArtistMessage', { n: tracklist.length }),
    confirmLabel: t('savedEntities.save'),
  });
}

export async function saveCollection(entity: SavedEntity, tracklist: CatalogItem[], opts: { confirmed?: boolean } = {}): Promise<void> {
  if (!opts.confirmed && !(await confirmSaving(entity, tracklist))) return;
  await setEntitySaved(entity, true);
  if (!isEntitySaved(entity)) return;
  await actions.setSongsSaved(songEntries(tracklist), true);
}

export async function unsaveCollection(entity: SavedEntity, tracklist: CatalogItem[]): Promise<void> {
  const entries = songEntries(tracklist);
  const leaving = removableSongs(entries);
  if (leaving > 0) {
    const ok = await confirmDialog({
      title: t('collectionControl.unsaveTitle', { title: entity.name }),
      message: t('collectionControl.unsaveMessage', { n: leaving }),
      confirmLabel: t('collectionControl.unsaveConfirm'),
      danger: true,
    });
    if (!ok) return;
  }
  await setEntitySaved(entity, false, { quiet: true });
  if (isEntitySaved(entity)) return;
  await actions.setSongsSaved(entries, false);
  toast.action(t('savedEntities.removed'), t('savedEntities.undo'), () => void saveCollection(entity, tracklist, { confirmed: true }));
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

/** The songs of an album or artist known only by its link — a card, a saved
 * row. A library album holds files already, so there is nothing to save for
 * it; an artist with no catalogue id cannot be read, so it stays a bookmark. */
export async function collectionTracklistFor(entity: SavedEntity): Promise<CatalogItem[]> {
  const params = new URLSearchParams(entity.destination.split('?')[1] ?? '');
  const deezerId = params.get('deezer_id') ?? undefined;
  if (entity.kind === 'artist') return deezerId ? discographyOf(deezerId) : [];
  if (params.get('album_id') && !deezerId) return [];
  try {
    const profile = await api.getAlbumProfile(entity.name, entity.artist ?? params.get('artist') ?? '', deezerId);
    return profile.resolved ? profile.tracklist : [];
  } catch {
    return [];
  }
}

/** Save or take out an album or artist known only by its link, as its page would. */
export async function toggleCollectionFromLink(entity: SavedEntity): Promise<void> {
  if (isEntitySaved(entity)) {
    await unsaveCollection(entity, await collectionTracklistFor(entity));
    return;
  }
  if (entity.kind === 'artist') {
    // An artist is read before anything is saved, to say how much will be.
    await saveCollection(entity, await collectionTracklistFor(entity));
    return;
  }
  // An album's bookmark answers at once; its songs follow once it is read.
  await setEntitySaved(entity, true);
  if (!isEntitySaved(entity)) return;
  await actions.setSongsSaved(songEntries(await collectionTracklistFor(entity)), true);
}
