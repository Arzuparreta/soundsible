/**
 * What can be done with a collection — an album, an artist, a playlist — and
 * the one menu that offers it, wherever the collection is shown.
 *
 * The album, artist and playlist menus each carried their own play and
 * shuffle, and none of them could start a DJ session from NORMAL. They now
 * share these commands, and so does the player's search panel: the same
 * collection offers the same actions inside the player and outside it.
 *
 * - NORMAL: play, shuffle, start a DJ session from the collection.
 * - DJ: start a new session from it (what play means in DJ); inside the
 *   player, also mix it into the session or change the session to it.
 */
import { player } from '../stores/player';
import { api } from '../lib/api';
import { itemArtist } from '../lib/catalogItem';
import { catalogDestination } from '../lib/musicNavigation';
import { playCatalogItem, useCatalogCollection } from '../lib/catalogItem';
import { CATALOG_DJ_SOURCE_LIMIT, startDjFromCatalog, startDjFromTracks } from '../lib/djStart';
import { shuffled } from '../lib/shuffle';
import { isPodcastTrack } from '../lib/track';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { CatalogItem, Track } from '../types/music';
import type { MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import { openContextMenu } from '../lib/contextMenu';
import type { MenuEvent } from '../lib/menuEvent';

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
  const songs = await load(collection);
  if (!songs) return;
  if ('tracks' in songs) startDjFromTracks(songs.tracks, collection.title);
  else await startDjFromCatalog(songs.items, collection.title);
}

/** Play the collection. In a DJ session that is a new session from it. */
export async function playCollection(collection: MusicCollection, shuffle = false): Promise<void> {
  if (player().autoMode.active) return startDjFromCollection(collection);
  const songs = await load(collection);
  if (!songs) return;
  if ('tracks' in songs) {
    if (shuffle) player().actions.playShuffled(songs.tracks, collection.context);
    else player().actions.playFrom(songs.tracks, 0, { context: collection.context });
    return;
  }
  const order = shuffle ? shuffled(songs.items) : songs.items;
  await playCatalogItem(order[0], order, collection.context);
}

/** Use the collection in the session that is playing: as one more source, or
 * as the source it changes to. */
export async function useCollectionInSession(collection: MusicCollection, purpose: 'reference' | 'change'): Promise<void> {
  const songs = await load(collection);
  if (!songs || !player().autoMode.active) return;
  if ('items' in songs) {
    await useCatalogCollection(songs.items.slice(0, CATALOG_DJ_SOURCE_LIMIT), collection.title, purpose);
    return;
  }
  if (purpose === 'change') {
    await player().actions.changeAutoSession(songs.tracks, collection.title);
    return;
  }
  player().actions.addAutoSource(songs.tracks, collection.title);
  toast.success(t('autoMode.source.added', { title: collection.title }));
}

/** The collection's commands for the mode the player is in. A DJ session is
 * edited only inside the player (`shell`); outside it a collection can start a
 * new session, never change the one playing. */
export function collectionActions(collection: MusicCollection, opts: { shell?: boolean } = {}): MenuAction[] {
  if (player().autoMode.active) {
    return [
      { icon: menuIcons.play(), label: t('autoMode.startDj'), onSelect: () => void startDjFromCollection(collection) },
      ...(opts.shell ? [
        { icon: menuIcons.source(), label: t('musicExplorer.reference'), onSelect: () => void useCollectionInSession(collection, 'reference') },
        { icon: menuIcons.changeSession(), label: t('musicExplorer.change'), onSelect: () => void useCollectionInSession(collection, 'change') },
      ] : []),
    ];
  }
  return [
    { icon: menuIcons.play(), label: t('collection.play'), onSelect: () => void playCollection(collection) },
    { icon: menuIcons.shuffle(), label: t('collection.shuffle'), onSelect: () => void playCollection(collection, true) },
    { icon: menuIcons.changeSession(), label: t('autoMode.startDj'), onSelect: () => void startDjFromCollection(collection) },
  ];
}

function externalId(item: CatalogItem, key: 'deezer_artist_id' | 'deezer_album_id'): string | undefined {
  const value = item.external_ids?.[key];
  return value ? String(value) : undefined;
}

/** A catalog artist or album as a collection: the artist's top songs, or the
 * album's tracklist, read from the catalog when a command runs. */
export function catalogEntityCollection(item: CatalogItem): MusicCollection | null {
  const destination = catalogDestination(item);
  if (item.type === 'artist') {
    const name = itemArtist(item) || item.title;
    return {
      title: name,
      context: { id: `artist:${name}`, kind: 'artist', label: name, destination },
      songs: async () => ({ items: (await api.getArtistProfile(name, externalId(item, 'deezer_artist_id'))).top_tracks ?? [] }),
    };
  }
  if (item.type === 'album') {
    return {
      title: item.title,
      context: { id: `album:${item.title}`, kind: 'album', label: item.title, cover: item.cover, destination },
      songs: async () => ({ items: (await api.getAlbumProfile(item.title, itemArtist(item), externalId(item, 'deezer_album_id'))).tracklist ?? [] }),
    };
  }
  return null;
}

/** The collection's actions inside the player, as a sheet (or a popover, from
 * a pointer), followed by the ones only its surface knows — its page, its
 * bookmark. */
export function openCollectionMenu(collection: MusicCollection, extra: MenuAction[] = [], event?: MenuEvent, subtitle?: string): void {
  openContextMenu({ title: collection.title, subtitle, actions: [...collectionActions(collection, { shell: true }), ...extra] }, event);
}
