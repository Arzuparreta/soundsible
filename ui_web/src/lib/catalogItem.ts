import { catalogMusic } from './musicNavigation';
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
      artist_is_channel: true,
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
    const track = await resolveCatalogTrack(item, signal);
    if (signal.aborted) return;
    if (!track) throw new Error('not-found');
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

/** One resolution path for individual and collection actions in every surface. */
export async function resolveCatalogTrack(item: CatalogItem, signal?: AbortSignal): Promise<Track | null> {
  const immediate = itemToTrack(item);
  if (immediate) return immediate;
  const artist = itemArtist(item);
  if (!artist || !item.title) return null;
  const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration }, signal);
  if (signal?.aborted || !resolved.video_id) return null;
  actions.linkCatalogItem(item.id, resolved.video_id);
  const music = catalogMusic(item);
  return {
    id: resolved.video_id, title: item.title, artist, album: item.album,
    artists: item.raw?.artists, album_artist: item.raw?.album_artist,
    deezer_artist_id: music.deezerArtistId, deezer_album_id: music.deezerAlbumId,
    duration: item.duration, cover: item.cover, source: 'preview', originKeys: catalogItemKeys(item),
    recommendation: item.raw?.recommendation,
  };
}

export async function useCatalogCollection(items: CatalogItem[], label: string, purpose: 'reference' | 'request', beforeQueueId?: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  const epoch = actions.autoSessionToken();
  const progress = toast.loading(t('collection.resolving'));
  const tracks: Track[] = [];
  const failed: string[] = [];
  for (let offset = 0; offset < items.length; offset += 3) {
    if (!state.autoMode.active || actions.autoSessionToken() !== epoch || !isCurrent()) { progress.dismiss(); return false; }
    const batch = await Promise.all(items.slice(offset, offset + 3).map(async (item) => {
      try {
        const track = await resolveCatalogTrack(item);
        if (track) return track;
      } catch { /* Keep the rest of the collection and report the missing title. */ }
      failed.push(item.title);
      return null;
    }));
    tracks.push(...batch.filter((track): track is Track => track !== null));
  }
  if (!state.autoMode.active || actions.autoSessionToken() !== epoch || !isCurrent()) { progress.dismiss(); return false; }
  progress.dismiss();
  if (purpose === 'request') await actions.placeAutoTracks(tracks, beforeQueueId);
  else if (tracks.length) actions.addAutoSource(tracks, label);
  if (failed.length) toast.error(t('musicExplorer.collectionFailed', { titles: failed.join(', ') }));
  else if (purpose === 'reference' && tracks.length) toast.success(t('autoMode.source.added', { title: label }));
  return tracks.length > 0 && isCurrent() && actions.autoSessionToken() === epoch;
}

export async function addCatalogItemsAsAutoSource(items: CatalogItem[], label: string): Promise<void> {
  await useCatalogCollection(items, label, 'reference');
}

/** Whether a catalog row is mid-flight — being matched, or matched and buffering.
 * Both read the same to a listener: it is working. */
export function itemBusy(item: CatalogItem): boolean {
  if (resolvingItemId() === item.id) return true;
  return state.playback.isLoading && isPlayingItem(item);
}
