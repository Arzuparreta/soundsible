/**
 * What can be done with a collection — an album, an artist, a playlist — and
 * the one menu that offers it, wherever the collection is shown.
 *
 * The album, artist and playlist menus each carried their own play and
 * shuffle, and none of them could start a DJ session from NORMAL. They now
 * share these commands, so a collection offers the same actions wherever it
 * is shown.
 *
 * - NORMAL: play, shuffle, start a DJ session from the collection.
 * - DJ: start a new session from it, which is what play means there.
 */
import { player } from '../stores/player';
import { playCatalogItem } from '../lib/catalogItem';
import { startDjFromCatalog, startDjFromTracks } from '../lib/djStart';
import { guardDjPick } from '../lib/djErrand';
import { shuffled } from '../lib/shuffle';
import { isPodcastTrack } from '../lib/track';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { CatalogItem, Track } from '../types/music';
import type { MenuAction } from './ActionMenu';
import { menuIcons } from './icons';

type Maybe<T> = T | Promise<T>;

/** A collection's songs: the library's, or the catalog's, matched to videos as
 * they are played. Read only when a command runs, never to draw the menu. */
export type CollectionSongs = { tracks: Track[] } | { items: CatalogItem[] };

export interface MusicCollection {
  title: string;
  context: PlaybackContextDescriptor;
  songs: () => Maybe<CollectionSongs>;
}

async function load(collection: MusicCollection): Promise<CollectionSongs | null> {
  try {
    const songs = await collection.songs();
    const count = 'tracks' in songs ? songs.tracks.filter((track) => !isPodcastTrack(track)).length : songs.items.length;
    return count ? songs : null;
  } catch {
    toast.error(t('searchPanel.noResolve'));
    return null;
  }
}

/** A new DJ session from the collection, from either mode. */
export async function startDjFromCollection(collection: MusicCollection): Promise<void> {
  const pickIsCurrent = guardDjPick();
  const songs = await load(collection);
  if (!songs || !pickIsCurrent()) return;
  if ('tracks' in songs) startDjFromTracks(songs.tracks, collection.title);
  else await startDjFromCatalog(songs.items, collection.title);
}

/** Play the collection. In a DJ session that is a new session from it. */
export async function playCollection(collection: MusicCollection, shuffle = false): Promise<void> {
  if (player().autoMode.active) return startDjFromCollection(collection);
  const pickIsCurrent = guardDjPick();
  const songs = await load(collection);
  if (!songs || !pickIsCurrent()) return;
  if ('tracks' in songs) {
    if (shuffle) player().actions.playShuffled(songs.tracks, collection.context);
    else player().actions.playFrom(songs.tracks, 0, { context: collection.context });
    return;
  }
  const order = shuffle ? shuffled(songs.items) : songs.items;
  await playCatalogItem(order[0], order, collection.context);
}

/** The collection's commands for the mode the player is in. During a DJ
 * session a collection starts a new session from it; mixing it into the
 * session or changing the session to it is asked for from the session itself
 * ("Mix with…", "Change…"), which then takes the collection the listener picks. */
export function collectionActions(collection: MusicCollection): MenuAction[] {
  if (player().autoMode.active) {
    return [{ icon: menuIcons.play(), label: t('autoMode.startDj'), onSelect: () => void startDjFromCollection(collection) }];
  }
  return [
    { icon: menuIcons.play(), label: t('collection.play'), onSelect: () => void playCollection(collection) },
    { icon: menuIcons.shuffle(), label: t('collection.shuffle'), onSelect: () => void playCollection(collection, true) },
    { icon: menuIcons.changeSession(), label: t('autoMode.startDj'), onSelect: () => void startDjFromCollection(collection) },
  ];
}
