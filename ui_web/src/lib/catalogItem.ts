import { createSignal } from 'solid-js';
import { api } from './api';
import { toast } from './toast';
import { t } from './i18n';
import { actions, isPlayingItem, state } from '../stores';
import { catalogItemKeys } from './playbackIdentity';
import type { CatalogItem, Track } from '../types/music';
import type { PlaybackContextDescriptor } from './playbackQueue';

/** Artist name for a catalog row, wherever the source put it. */
export function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

/** Exact playable YouTube identity already carried by a catalog row. */
export function catalogPreviewId(item: CatalogItem): string | null {
  const id = item.source === 'youtube' ? item.raw?.id : null;
  return typeof id === 'string' && id ? id : null;
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
    if (found) {
      return item.raw?.recommendation
        ? { ...found, recommendation: item.raw.recommendation }
        : found;
    }
  }
  const previewId = catalogPreviewId(item);
  if (previewId) {
    const raw = item.raw ?? {};
    return {
      id: previewId,
      title: String(raw.title || item.title),
      artist: String(raw.artist || itemArtist(item)),
      album: typeof raw.album === 'string' ? raw.album : item.album,
      duration: typeof raw.duration === 'number' ? raw.duration : item.duration,
      youtube_id: typeof raw.youtube_id === 'string' ? raw.youtube_id : undefined,
      cover: item.cover,
      source: 'preview',
      originKeys: catalogItemKeys(item),
      recommendation: raw.recommendation,
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
export async function playCatalogItem(
  item: CatalogItem,
  queue?: CatalogItem[],
  context?: PlaybackContextDescriptor,
): Promise<void> {
  const artist = itemArtist(item);
  if (!artist || !item.title) return;

  const existing = itemToTrack(item);
  if (existing) {
    if (queue) {
      const tracks = queue.map(itemToTrack).filter((tr): tr is Track => !!tr);
      if (tracks.length) actions.playFrom(tracks, 0, { context });
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
    actions.linkCatalogItem(item.id, resolved.video_id);
    const track: Track = {
      id: resolved.video_id,
      title: item.title,
      artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview',
      // Carry the row's identity along: the video id shares nothing with the
      // Deezer/MusicBrainz row that picked it, so without this the row could
      // not tell that the thing it just started is the thing now playing.
      originKeys: catalogItemKeys(item),
      recommendation: item.raw?.recommendation,
    };
    if (queue) {
      const rest = queue
        .filter((q) => q !== item)
        .map(itemToTrack)
        .filter((tr): tr is Track => !!tr);
      actions.playFrom([track, ...rest], 0, { context });
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

/** Resolve the playable roots of a catalogue collection and hand them to DJ.
 *
 * Album and artist profiles are metadata-first: many rows have title/artist but
 * no video id until somebody asks to hear them. A collection source must not
 * silently become empty just because those rows came from Deezer, so resolution
 * happens here in small batches and the usable subset is applied atomically. */
export async function addCatalogItemsAsAutoSource(items: CatalogItem[], label: string): Promise<void> {
  const progress = toast.loading(t('collection.resolving'));
  const selected = items.slice(0, 15);
  const tracks: Track[] = [];
  for (let offset = 0; offset < selected.length; offset += 3) {
    const batch = await Promise.all(selected.slice(offset, offset + 3).map(async (item) => {
      const immediate = itemToTrack(item);
      if (immediate) return immediate;
      const artist = itemArtist(item);
      if (!artist || !item.title) return null;
      try {
        const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
        if (!resolved.video_id) return null;
        actions.linkCatalogItem(item.id, resolved.video_id);
        return {
          id: resolved.video_id,
          title: item.title,
          artist,
          album: item.album,
          duration: item.duration,
          cover: item.cover,
          source: 'preview' as const,
          originKeys: catalogItemKeys(item),
        } satisfies Track;
      } catch {
        return null;
      }
    }));
    tracks.push(...batch.filter((track): track is Track => track !== null));
  }
  if (!state.autoMode.active) {
    progress.dismiss();
    return;
  }
  if (tracks.length === 0) {
    progress.update('error', t('toast.autoModeOpeningFailed'));
    return;
  }
  actions.addAutoSource(tracks, label);
  progress.update('success', t('autoMode.source.added', { title: label }));
}

/** Whether a catalog row is mid-flight — being matched, or matched and buffering.
 * Both read the same to a listener: it is working. */
export function itemBusy(item: CatalogItem): boolean {
  if (resolvingItemId() === item.id) return true;
  return state.playback.isLoading && isPlayingItem(item);
}
