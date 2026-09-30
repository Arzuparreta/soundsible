import { createSignal } from 'solid-js';
import { api } from './api';
import { t } from './i18n';
import { toast } from './toast';
import { pulseNavigation } from './tabNavigation';

export interface SavedEntity {
  kind: 'artist' | 'album';
  name: string;
  artist?: string;
  cover?: string;
  destination: string;
  keys?: string[];
  id?: string;
  added_at?: string;
}

export function entityKeys(entry: SavedEntity): string[] {
  const params = new URLSearchParams(entry.destination.split('?')[1]);
  const keys = [...(entry.keys ?? [])];
  for (const [param, namespace] of [[`${entry.kind}_id`, 'library'], ['deezer_id', 'deezer']]) {
    const id = params.get(param);
    if (id) keys.push(`${entry.kind}:${namespace}:${id}`);
  }
  return keys.filter((key) => !key.includes(':reference:'));
}

export function sameEntity(a: SavedEntity, b: SavedEntity): boolean {
  if (a.kind !== b.kind) return false;
  const ak = entityKeys(a), bk = entityKeys(b);
  if (ak.length || bk.length) return ak.some((key) => bk.includes(key));
  return a.name === b.name && (a.artist ?? '') === (b.artist ?? '');
}

export const [savedEntities, setSavedEntities] = createSignal<SavedEntity[]>([]);
export const [entitiesLoading, setEntitiesLoading] = createSignal(false);
export const [entitiesError, setEntitiesError] = createSignal(false);
export const [entitiesBusy, setEntitiesBusy] = createSignal(false);
let generation = 0;
let loading: Promise<void> | undefined;
let refreshQueued = false;

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
  loading = Promise.resolve().then(() => api.getSavedEntities()).then((entries) => {
    if (current !== generation) return;
    setSavedEntities(entries);
    setEntitiesError(false);
  }).catch(() => { if (current === generation) setEntitiesError(true); })
    .finally(() => {
      loading = undefined;
      setEntitiesLoading(false);
      flushQueuedRefresh();
    });
  return loading;
}

function flushQueuedRefresh(): void {
  if (!refreshQueued || entitiesBusy() || loading) return;
  refreshQueued = false;
  void syncSavedEntities();
}

/** `quiet` leaves the "removed" toast to a caller that says more (an album
 * takes its songs with it, and its undo has to bring them back too). */
export async function setEntitySaved(entry: SavedEntity, saved: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
  if (entitiesBusy()) return;
  ++generation;
  setEntitiesBusy(true);
  const previous = savedEntities();
  setSavedEntities(saved
    ? (isEntitySaved(entry) ? previous : [entry, ...previous])
    : previous.filter((item) => !sameEntity(item, entry)));
  try {
    setSavedEntities(await api.setSavedEntity(entry, saved));
    setEntitiesError(false);
    if (saved) pulseNavigation(['/', entry.kind === 'album' ? '/?saved=albums' : '/?saved=artists']);
    if (!saved && !opts.quiet) toast.action(t('savedEntities.removed'), t('savedEntities.undo'), () => void setEntitySaved(entry, true));
  } catch {
    setSavedEntities(previous);
    toast.error(t('savedEntities.failed'));
  } finally {
    setEntitiesBusy(false);
    flushQueuedRefresh();
  }
}
