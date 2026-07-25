import { createSignal } from 'solid-js';
import { api } from './api';
import { toast } from './toast';
import { t } from './i18n';
import { actions, state } from '../stores';
import type { CatalogItem, Track } from '../types/music';

/** Artist name for a catalog row, wherever the source put it. */
export function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

/**
 * The playable track behind a catalog row, if there already is one.
 *
 * Two ways a row is playable without asking the engine: it is a track we own
 * (`track_id` resolves in the library), or the search layer already attached a
 * raw YouTube payload. Otherwise `null` — the row needs `playCatalogItem`.
 */
export function itemToTrack(item: CatalogItem): Track | null {
  if (item.track_id) {
    const found = state.library.find((tr) => tr.id === item.track_id);
    if (found) return found;
  }
  if (item.raw?.id && typeof item.raw.id === 'string') {
    return {
      id: item.raw.id,
      title: String(item.raw.title || item.title),
      artist: String(item.raw.artist || itemArtist(item)),
      album: typeof item.raw.album === 'string' ? item.raw.album : item.album,
      duration: typeof item.raw.duration === 'number' ? item.raw.duration : item.duration,
      youtube_id: typeof item.raw.youtube_id === 'string' ? item.raw.youtube_id : undefined,
      cover: item.cover,
    };
  }
  return null;
}

/** Catalog row currently being matched to a YouTube video, if any. Read it in a
 * tracking scope to put a spinner on exactly the row that was tapped. */
const [resolvingItemId, setResolvingItemId] = createSignal<string | null>(null);
export { resolvingItemId };

let resolveAborter: AbortController | undefined;

/** Drop any in-flight resolve (route teardown). */
export function cancelCatalogResolve(): void {
  resolveAborter?.abort();
  resolveAborter = undefined;
  setResolvingItemId(null);
}

/**
 * Play a catalog row, resolving it to a YouTube video first if needed.
 *
 * Deezer/MusicBrainz rows carry no video id, so playing one costs a server-side
 * search. Three properties matter, and every surface that plays catalog rows
 * gets them from here rather than reimplementing them:
 *
 * - **Idempotent.** Tapping the row that is already resolving does nothing.
 * - **Last click wins.** A new pick aborts the previous resolve, so a slow
 *   first choice cannot hijack playback seconds after the user moved on.
 * - **Visible.** `resolvingItemId` marks the row, so the wait shows up under
 *   the finger instead of as a toast.
 *
 * With `queue`, the row's siblings become the rest of the playback queue (the
 * resolved track is *prepended* rather than written over index 0, which would
 * evict an owned track).
 */
export async function playCatalogItem(item: CatalogItem, queue?: CatalogItem[]): Promise<void> {
  const artist = itemArtist(item);
  if (!artist || !item.title) return;

  const existing = itemToTrack(item);
  if (existing) {
    if (queue) {
      const tracks = queue.map(itemToTrack).filter((tr): tr is Track => !!tr);
      if (tracks.length) actions.playFrom(tracks, 0);
      else actions.playTrack(existing);
    } else {
      actions.playTrack(existing);
    }
    return;
  }

  if (resolvingItemId() === item.id) return;
  resolveAborter?.abort();
  resolveAborter = new AbortController();
  const signal = resolveAborter.signal;
  setResolvingItemId(item.id);
  try {
    const resolved = await api.resolveCatalogItem(
      { artist, title: item.title, duration: item.duration },
      signal,
    );
    if (signal.aborted) return;
    if (!resolved.video_id) throw new Error('not-found');
    const track: Track = {
      id: resolved.video_id,
      title: item.title,
      artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview',
    };
    if (queue) {
      const rest = queue
        .filter((q) => q !== item)
        .map(itemToTrack)
        .filter((tr): tr is Track => !!tr);
      actions.playFrom([track, ...rest], 0);
    } else {
      actions.playTrack(track);
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
    toast.error(t('search.noPreview'));
  } finally {
    if (!signal.aborted) setResolvingItemId(null);
  }
}

/** Whether a catalog row is mid-flight — being matched, or matched and buffering.
 * Both read the same to a listener: it is working. */
export function itemBusy(item: CatalogItem): boolean {
  if (resolvingItemId() === item.id) return true;
  const playing = state.playback.currentTrack?.id;
  return state.playback.isLoading && !!playing && playing === (item.track_id || item.id);
}
