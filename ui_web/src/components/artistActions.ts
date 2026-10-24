import { savedEntityAction } from './savedEntityActions';
import { artistPath } from '../lib/artistRoute';
import { artistDestination, navigateMusic } from '../lib/musicNavigation';
import { type ActionMenuOptions, type MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import { openContextMenu } from '../lib/contextMenu';
import { actions, musicLibrary, state } from '../stores';
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

/** Play / shuffle / go-to-artist menu definition for an artist. */
export function artistMenuOptions(artist: string, _ctx: ArtistMenuContext = {}): ActionMenuOptions {
  const list: MenuAction[] = [
    { icon: menuIcons.play(), label: t('artistActions.play'), onSelect: () => {
      const tracks = artistTracks(artist);
      if (state.autoMode.active) actions.startDjSelection(tracks, artist);
      else actions.playFrom(tracks, 0, { context: artistContext(artist) });
    } },
    { icon: menuIcons.shuffle(), label: t('artistActions.shuffle'), onSelect: () => {
      actions.playShuffled(artistTracks(artist), artistContext(artist));
    } },
  ];
  list.push({ icon: menuIcons.artist(), label: t('artistActions.goToArtist'), onSelect: () => navigateMusic(artistDestination({ artist, view: 'library' }, artist)) });
  list.push(savedEntityAction({ kind: 'artist', name: artist, cover: _ctx.cover, destination: artistPath(artist, { view: 'library', artistId: _ctx.artistId }) }));
  return { title: artist, actions: list };
}

/** Open the artist menu. Pass the triggering event to anchor a cursor popover. */
export function openArtistMenu(artist: string, ctx: ArtistMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(artistMenuOptions(artist, ctx), ev);
}
