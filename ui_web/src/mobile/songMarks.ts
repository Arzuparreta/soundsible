import { request } from '../lib/http';
import { savedFromTrack } from '../lib/saved';
import { t } from '../lib/i18n';
import { vibrate } from '../lib/haptics';
import type { SavedEntry, Track } from '../types/music';
import type { MenuAction } from '../components/ActionMenu';

/** Menus retain intention and account; a delayed selection cannot toggle a new state. */
export function songMarkAction(track: Track, entries: () => SavedEntry[], generation: () => number,
  unavailable: () => boolean, refresh: () => Promise<void>, failed: () => void): MenuAction {
  const entry = savedFromTrack(track); const account = generation();
  const marked = entries().some(row => row.favourite && row.keys.some(key => entry.keys.includes(key)));
  return { label: t(marked ? 'trackActions.removeFav' : 'trackActions.addFav'), disabled: unavailable(), onSelect: () => {
    if (generation() !== account || unavailable()) return;
    void request<{ is_favourite: boolean }>('/api/library/favourites', { method: 'PUT', body: { entry, marked: !marked }, timeoutMs: 15000 }).then(async result => {
      if (generation() !== account) return;
      if (result.is_favourite !== !marked) throw new Error('Missing favourite confirmation');
      vibrate();
      await refresh();
    }).catch(() => { if (generation() === account) failed(); });
  } };
}
