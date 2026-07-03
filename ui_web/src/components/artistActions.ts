import { type ActionMenuOptions, type MenuAction } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import { actions, musicLibrary } from '../stores';
import type { Track } from '../types/music';
import { artistKey, artistPath } from '../lib/artistRoute';
import { t } from '../lib/i18n';

export interface ArtistMenuContext {
  navigate?: (path: string) => void;
}

function artistTracks(artist: string): Track[] {
  const key = artistKey(artist);
  return musicLibrary().filter((t) => artistKey(t.artist) === key || artistKey(t.album_artist) === key);
}

/** Play / shuffle / go-to-artist menu definition for an artist. */
export function artistMenuOptions(artist: string, ctx: ArtistMenuContext = {}): ActionMenuOptions {
  const list: MenuAction[] = [
    {
      label: t('artistActions.play'),
      onSelect: () => {
        const t = artistTracks(artist);
        if (t.length) actions.playFrom(t, 0);
      },
    },
    {
      label: t('artistActions.shuffle'),
      onSelect: () => {
        const t = artistTracks(artist);
        if (t.length) actions.playShuffled(t);
      },
    },
  ];
  if (ctx.navigate)
    list.push({ label: t('artistActions.goToArtist'), onSelect: () => ctx.navigate!(artistPath(artist)) });
  return { title: artist, actions: list };
}

/** Open the artist menu. Pass the triggering event to anchor a cursor popover. */
export function openArtistMenu(artist: string, ctx: ArtistMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(artistMenuOptions(artist, ctx), ev);
}
