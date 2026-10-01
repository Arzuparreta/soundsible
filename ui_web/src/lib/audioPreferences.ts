const VOLUME_KEY = 'volume';

/** Read the persisted volume without forcing the lazy elements into existence. */
export function storedVolume(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

