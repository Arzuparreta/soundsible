import type { LibraryDelta, LibrarySnapshot } from './api';
import type { Track } from '../types/music';

/** Validate everything before touching the store. Changed rows are replacements,
 * so omitted annotations disappear; unchanged rows retain their object identity. */
export function applyLibraryDelta(tracks: Track[], delta: LibraryDelta, revision?: string): {
  tracks: Track[]; fields: Partial<LibrarySnapshot>; revision: string; upserts: Track[]; removed: string[];
} {
  const rawRevision = revision?.replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!rawRevision || delta.base_revision !== rawRevision || !/^[a-f0-9]{64}$/.test(delta.revision)
    || !Array.isArray(delta.upserts) || !Array.isArray(delta.removed)
    || !delta.fields || typeof delta.fields !== 'object' || Array.isArray(delta.fields)) {
    throw new Error('Invalid library delta');
  }
  const allowed = new Set(['version', 'last_updated', 'playlists', 'settings', 'podcast_subscriptions', 'podcast_episode_cache']);
  if (Object.keys(delta.fields).some(key => !allowed.has(key))) throw new Error('Invalid delta fields');
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const fields = delta.fields;
  if (('playlists' in fields && (!object(fields.playlists) || Object.values(fields.playlists).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))))
    || ('settings' in fields && !object(fields.settings))
    || ('podcast_subscriptions' in fields && (!Array.isArray(fields.podcast_subscriptions) || fields.podcast_subscriptions.some(row => !object(row))))) {
    throw new Error('Invalid delta fields');
  }
  const rows = new Map(tracks.map(track => [track.id, track]));
  if (rows.size !== tracks.length) throw new Error('Ambiguous library IDs');
  const removed = new Set<string>();
  for (const id of delta.removed) {
    if (typeof id !== 'string' || removed.has(id) || !rows.has(id)) throw new Error('Invalid delta deletion');
    removed.add(id);
    rows.delete(id);
  }
  const updated = new Set<string>();
  for (const track of delta.upserts) {
    if (!track || typeof track.id !== 'string' || typeof track.title !== 'string'
      || updated.has(track.id) || removed.has(track.id)) throw new Error('Invalid delta track');
    updated.add(track.id);
    rows.set(track.id, track);
  }
  let next: Track[];
  if (delta.order !== undefined) {
    if (!Array.isArray(delta.order) || delta.order.length !== rows.size
      || new Set(delta.order).size !== rows.size || delta.order.some(id => !rows.has(id))) {
      throw new Error('Invalid delta order');
    }
    next = delta.order.map(id => rows.get(id)!);
  } else {
    if (delta.removed.length || rows.size !== tracks.length) throw new Error('Missing delta order');
    next = delta.upserts.length ? tracks.map(track => rows.get(track.id)!) : tracks;
  }
  return { tracks: next, fields: delta.fields, revision: `W/"${delta.revision}"`, upserts: delta.upserts, removed: delta.removed };
}
