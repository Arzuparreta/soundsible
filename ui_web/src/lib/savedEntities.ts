import { createSignal } from 'solid-js';
import { api } from './api';
import { t } from './i18n';
import { toast } from './toast';
import { pulseNavigation } from './tabNavigation';

import { sameEntity, type SavedEntity } from './savedEntityIdentity';
export { entityKeys, sameEntity, type SavedEntity } from './savedEntityIdentity';

export const [savedEntities, setSavedEntities] = createSignal<SavedEntity[]>([]);
export const [entitiesLoading, setEntitiesLoading] = createSignal(false);
export const [entitiesError, setEntitiesError] = createSignal(false);
export const [entitiesBusy, setEntitiesBusy] = createSignal(false);
let generation = 0;
let loading: Promise<void> | undefined;
let refreshQueued = false;

export function resetSavedEntities(): void {
  ++generation;
  loading = undefined;
  refreshQueued = false;
  setSavedEntities([]);
  setEntitiesLoading(false);
  setEntitiesError(false);
  setEntitiesBusy(false);
}

export function isEntitySaved(entry: SavedEntity): boolean {
  return savedEntities().some((item) => sameEntity(item, entry));
}

export function syncSavedEntities(): Promise<void> {
  if (loading || entitiesBusy()) {
    refreshQueued = true;
    return loading ?? Promise.resolve();
  }
  const current = ++generation;
  setEntitiesLoading(true);
  const task = Promise.resolve().then(() => api.getSavedEntities()).then((entries) => {
    if (current !== generation) return;
    setSavedEntities(entries);
    setEntitiesError(false);
  }).catch(() => { if (current === generation) setEntitiesError(true); })
    .finally(() => {
      if (loading !== task) return;
      loading = undefined;
      setEntitiesLoading(false);
      flushQueuedRefresh();
    });
  loading = task;
  return task;
}

function flushQueuedRefresh(): void {
  if (!refreshQueued || entitiesBusy() || loading) return;
  refreshQueued = false;
  void syncSavedEntities();
}

/** Save or remove only the navigation bookmark, independently of songs. */
export async function setEntitySaved(entry: SavedEntity, saved: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
  if (entitiesBusy()) return;
  const current = ++generation;
  setEntitiesBusy(true);
  const previous = savedEntities();
  setSavedEntities(saved
    ? (isEntitySaved(entry) ? previous : [entry, ...previous])
    : previous.filter((item) => !sameEntity(item, entry)));
  try {
    const entries = await api.setSavedEntity(entry, saved);
    if (current !== generation) return;
    setSavedEntities(entries);
    setEntitiesError(false);
    if (saved) pulseNavigation(['/', entry.kind === 'album' ? '/?saved=albums' : '/?saved=artists']);
    if (!saved && !opts.quiet) toast.action(t('savedEntities.removed'), t('savedEntities.undo'), () => void setEntitySaved(entry, true));
  } catch {
    if (current !== generation) return;
    setSavedEntities(previous);
    toast.error(t('savedEntities.failed'));
  } finally {
    if (current !== generation) return;
    setEntitiesBusy(false);
    flushQueuedRefresh();
  }
}

/** Give a saved bookmark that has no picture the one its page now shows. Quiet:
 * it is not the person saving anything, so a failure waits for the next visit. */
export async function fillEntityCover(entry: SavedEntity): Promise<void> {
  const stored = savedEntities().find((item) => sameEntity(item, entry));
  if (!stored || stored.cover || !entry.cover || entitiesBusy()) return;
  const current = ++generation;
  setEntitiesBusy(true);
  try {
    const entries = await api.setSavedEntity({ ...stored, cover: entry.cover }, true);
    if (current !== generation) return;
    setSavedEntities(entries);
  } catch {
    /* tried again on the next visit */
  } finally {
    if (current !== generation) return;
    setEntitiesBusy(false);
    flushQueuedRefresh();
  }
}
