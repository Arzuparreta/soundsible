import type { MenuEvent } from '../lib/menuEvent';
import { savedEntityAction } from './savedEntityActions';
import { collectionActions, type MusicCollection } from './collectionCommands';
import { artistPath } from '../lib/artistRoute';
import { artistDestination, navigateMusic } from '../lib/musicNavigation';
import { type ActionMenuOptions, type MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import { openContextMenu } from '../lib/contextMenu';
import { musicLibrary } from '../stores';
import type { Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';
import { artistKey } from '../lib/artistRoute';
import { t } from '../lib/i18n';

export interface ArtistMenuContext {
  artistId?: string;
  cover?: string;
  navigate?: (path: string) => void;
}

function artistTracks(artist: string): Track[] {
  const key = artistKey(artist);
  return musicLibrary().filter((t) => artistKey(t.artist) === key || artistKey(t.album_artist) === key
    || t.artists?.some((name) => artistKey(name) === key));
}

function artistContext(artist: string): PlaybackContextDescriptor {
  return {
    id: `artist:${artist}`,
    kind: 'artist',
    label: artist,
    destination: artistDestination({ artist, view: 'library' }, artist),
  };
}

/** A library artist as a collection the shared commands can play. */
export function artistCollection(artist: string): MusicCollection {
  return { title: artist, context: artistContext(artist), songs: () => ({ tracks: artistTracks(artist) }) };
}

/** The artist's collection commands, then go-to-artist and bookmark. */
export function artistMenuOptions(artist: string, _ctx: ArtistMenuContext = {}): ActionMenuOptions {
  const list: MenuAction[] = [
    ...collectionActions(artistCollection(artist)),
    { icon: menuIcons.artist(), label: t('artistActions.goToArtist'), onSelect: () => navigateMusic(artistDestination({ artist, view: 'library' }, artist)) },
    savedEntityAction({ kind: 'artist', name: artist, cover: _ctx.cover, destination: artistPath(artist, { view: 'library', artistId: _ctx.artistId }) }),
  ];
  return { title: artist, actions: list };
}

/** Open the artist menu. Pass the triggering event to anchor a cursor popover. */
export function openArtistMenu(artist: string, ctx: ArtistMenuContext = {}, ev?: MenuEvent): void {
  openContextMenu(artistMenuOptions(artist, ctx), ev);
}
