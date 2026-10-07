import { catalogTrack, itemArtist } from './catalogTrack';
import { catalogMusic } from './musicNavigation';
import { createSignal } from 'solid-js';
import { api } from './api';
import { toast } from './toast';
import { t } from './i18n';
import { actions, isPlayingItem, state } from '../stores';
import { catalogItemKeys } from './playbackIdentity';
import type { CatalogItem, Track } from '../types/music';
import type { ContextTrack, PlaybackContextDescriptor } from './playbackQueue';

export { itemArtist, catalogPreviewId } from './catalogTrack';
export function itemToTrack(item: CatalogItem): Track | null { return catalogTrack(item, state.library); }

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
 * With `queue`, the row plays from its own place in it and the whole of the
 * queue becomes the context, in its order: the rows before it are what
 * "previous" goes back to, the rows after it are what follows. Rows that still
 * need matching keep their place as references the player matches shortly
 * before it reaches them — only the row that was tapped is matched up front.
 * Without `queue` the row is a selection of its own.
 */
export async function playCatalogItem(
  item: CatalogItem,
  queue?: CatalogItem[],
  context?: PlaybackContextDescriptor,
): Promise<void> {
  const artist = itemArtist(item);
  if (!artist || !item.title) return;

  const play = (track: Track) => {
    if (!queue) {
      actions.playTrack(track);
      return;
    }
    const { tracks, index } = catalogContext(queue, item, track);
    actions.playFrom(tracks, index, { context });
  };

  const existing = itemToTrack(item);
  if (existing) {
    play(existing);
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
    play(track);
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
    toast.error(t('search.noPreview'));
  } finally {
    if (!signal.aborted) setResolvingItemId(null);
  }
}

/**
 * A catalog row as a context song: playable when it already is, otherwise a
 * reference in its place that the player matches before reaching it. Rows that
 * name no song at all — no artist, no title — cannot become either.
 */
export function catalogContextTrack(item: CatalogItem): ContextTrack | null {
  const playable = itemToTrack(item);
  if (playable) return playable;
  const artist = itemArtist(item);
  if (!artist || !item.title) return null;
  const music = catalogMusic(item);
  return {
    id: `pending:${item.id}`,
    title: item.title,
    artist,
    album: item.album,
    artists: item.raw?.artists,
    album_artist: item.raw?.album_artist,
    deezer_artist_id: music.deezerArtistId,
    deezer_album_id: music.deezerAlbumId,
    duration: item.duration,
    cover: item.cover,
    source: 'preview',
    originKeys: catalogItemKeys(item),
    recommendation: item.raw?.recommendation,
    pendingResolve: { catalogItemId: item.id, artist, title: item.title, duration: item.duration },
  };
}

/**
 * The context a tapped catalog row plays in, and where in it the row sits.
 *
 * Found by reference first — the surfaces hand over the very row from the list
 * they rendered — and by id after that. A row that is not in the list at all
 * still plays, first, ahead of the list.
 */
export function catalogContext(
  queue: CatalogItem[],
  item: CatalogItem,
  track: Track,
): { tracks: ContextTrack[]; index: number } {
  let position = queue.indexOf(item);
  if (position === -1) position = queue.findIndex((row) => row.id === item.id);
  const tracks: ContextTrack[] = [];
  let index = 0;
  if (position === -1) tracks.push(track);
  queue.forEach((row, rowIndex) => {
    if (rowIndex === position) {
      index = tracks.length;
      tracks.push(track);
      return;
    }
    const song = catalogContextTrack(row);
    if (song) tracks.push(song);
  });
  return { tracks, index };
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
    id: resolved.video_id, title: item.title, artist, album: item.album, artist_is_channel: false,
    artists: item.raw?.artists, album_artist: item.raw?.album_artist,
    deezer_artist_id: music.deezerArtistId, deezer_album_id: music.deezerAlbumId,
    duration: item.duration, cover: item.cover, source: 'preview', originKeys: catalogItemKeys(item),
    recommendation: item.raw?.recommendation,
  };
}

export async function useCatalogCollection(items: CatalogItem[], label: string, purpose: 'reference' | 'request' | 'change', beforeQueueId?: string, isCurrent: () => boolean = () => true, reservedEpoch?: number, onChangeStarted?: () => void): Promise<boolean> {
  const epoch = reservedEpoch ?? (purpose === 'change' ? actions.beginAutoSessionChange() : actions.autoSessionToken());
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
  if (purpose === 'change') {
    if (failed.length) toast.error(t('musicExplorer.collectionFailed', { titles: failed.join(', ') }));
    if (!tracks.length) return false;
    const changing = actions.changeAutoSession(tracks, label);
    onChangeStarted?.();
    return changing;
  }
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
