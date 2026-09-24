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
  const inAuto = state.autoMode.active;
  const list: MenuAction[] = [
    {
      icon: inAuto ? menuIcons.queue() : menuIcons.play(),
      label: inAuto ? t('musicExplorer.requestAll') : t('artistActions.play'),
      onSelect: () => {
        const t = artistTracks(artist);
        if (t.length) {
          if (state.autoMode.active) void actions.placeAutoTracks(t);
          else {
            actions.playFrom(t, 0, { context: artistContext(artist) });
          }
        }
      },
    },
  ];
  if (inAuto) list.push({ icon: menuIcons.source(), label: t('musicExplorer.reference'), onSelect: () => actions.addAutoSource(artistTracks(artist), artist) });
  if (inAuto) list.push({ icon: menuIcons.changeSession(), label: t('musicExplorer.change'), onSelect: () => void actions.changeAutoSession(artistTracks(artist), artist) });
  if (!inAuto) list.push({
      icon: menuIcons.shuffle(),
      label: t('artistActions.shuffle'),
      onSelect: () => {
        const t = artistTracks(artist);
        if (t.length) {
          actions.playShuffled(t, artistContext(artist));
        }
      },
    });
  list.push({ icon: menuIcons.artist(), label: t('artistActions.goToArtist'), onSelect: () => navigateMusic(artistDestination({ artist, view: 'library' }, artist)) });
  return { title: artist, actions: list };
}

/** Open the artist menu. Pass the triggering event to anchor a cursor popover. */
export function openArtistMenu(artist: string, ctx: ArtistMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(artistMenuOptions(artist, ctx), ev);
}
