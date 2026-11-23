/**
 * Starting a DJ session from music the listener picked, in either mode.
 *
 * `startDjSelection` only acts inside a session. Before this module each
 * surface that offered "Start a DJ session" from NORMAL entered DJ mode on its
 * own first — the artist page did, the album and playlist pages did not offer
 * it at all. Every surface now starts the same way: the session opens on the
 * selection, from its first playable song, at once.
 */
import { player } from '../stores/player';
import { toast } from './toast';
import { t } from './i18n';
import { isPodcastTrack } from './track';
import { itemToTrack, resolveCatalogTrack, useCatalogCollection } from './catalogItem';
import type { CatalogItem, Track } from '../types/music';

/** How many catalog songs a collection hands the DJ: enough to plan from,
 * without matching a whole discography up front. */
export const CATALOG_DJ_SOURCE_LIMIT = 10;

function podcastPlaying(): boolean {
  const current = player().playback.currentTrack;
  return Boolean(current && isPodcastTrack(current));
}

/** Enter DJ mode, if it is off, ready to open on `source`. False when it could
 * not: a podcast is playing, and DJ only mixes music. */
function enterFor(source: Track): boolean {
  if (player().autoMode.active) return true;
  if (blockedByPodcast()) return false;
  player().actions.enterAutoMode({ source, deferPlanning: true });
  // A controlled device starts its own session with the selection that follows.
  if (!player().remote && !player().autoMode.active) {
    toast.info(t('modeChange.podcastMessage'));
    return false;
  }
  return true;
}

/** DJ cannot start over a podcast; say so before any song is matched. */
export function blockedByPodcast(): boolean {
  if (player().autoMode.active || !podcastPlaying()) return false;
  toast.info(t('modeChange.podcastMessage'));
  return true;
}

/** A new DJ session from songs at hand. */
export function startDjFromTracks(tracks: readonly Track[], label: string): boolean {
  if (blockedByPodcast()) return false;
  const music = tracks.filter((track) => !isPodcastTrack(track) && !track.unavailable);
  if (!music.length || !enterFor(music[0])) return false;
  return player().actions.startDjSelection(music, label);
}

/** The first row of `items` that plays, matching rows to videos in order
 * until one answers. Rows already playable are taken without a request. */
export async function firstPlayable(
  items: readonly CatalogItem[],
  isCurrent: () => boolean = () => true,
): Promise<{ track: Track; index: number } | null> {
  for (let index = 0; index < items.length; index++) {
    const known = itemToTrack(items[index]);
    if (known && !isPodcastTrack(known)) return { track: known, index };
  }
  for (let index = 0; index < items.length; index++) {
    if (!isCurrent()) return null;
    const track = await resolveCatalogTrack(items[index]).catch(() => null);
    if (!isCurrent()) return null;
    if (track && !isPodcastTrack(track)) return { track, index };
  }
  return null;
}

/** A new DJ session from catalog songs. The first playable one is matched
 * before anything else, so the session can open; the rest are matched as the
 * source is built. */
export async function startDjFromCatalog(
  items: readonly CatalogItem[],
  label: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const candidates = items.slice(0, CATALOG_DJ_SOURCE_LIMIT);
  if (!candidates.length || blockedByPodcast()) return false;
  const found = await firstPlayable(candidates, isCurrent);
  if (!isCurrent()) return false;
  if (!found) {
    toast.error(t('search.noPreview'));
    return false;
  }
  if (!enterFor(found.track)) return false;
  // The row already matched keeps its video, so it is not matched twice.
  const seeded = candidates.map((item, index) => (
    index === found.index && found.track.source === 'preview'
      ? { ...item, external_ids: { ...item.external_ids, youtube_id: found.track.id } }
      : item
  ));
  return useCatalogCollection(seeded, label, 'start', undefined, isCurrent);
}
