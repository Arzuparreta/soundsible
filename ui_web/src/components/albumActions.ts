import { type ActionMenuOptions, type MenuAction } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import { actions } from '../stores';
import { api } from '../lib/api';
import { tracksByIds } from '../lib/catalogTracks';
import { albumPath } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { CatalogAlbum, Track } from '../types/music';

export interface AlbumMenuContext {
  navigate?: (path: string) => void;
}

/** This record's tracks, in the order the record has them.
 *
 * Asked of the engine rather than filtered out of the library by title: which
 * songs are on a record is the catalog's answer, and matching on a name here is
 * how two records that share one end up playing as a single mixed-up album. */
async function albumTracks(album: CatalogAlbum): Promise<Track[]> {
  const { track_ids } = await api.getLibraryAlbum(album.id);
  return tracksByIds(track_ids ?? []);
}

function albumContext(album: CatalogAlbum) {
  return { id: `album:${album.id}`, kind: 'album' as const, label: album.title };
}

/** Play / shuffle / go-to-album menu definition for a catalog album. */
export function albumMenuOptions(album: CatalogAlbum, ctx: AlbumMenuContext = {}): ActionMenuOptions {
  const list: MenuAction[] = [
    {
      label: t('albumActions.play'),
      onSelect: () => {
        void albumTracks(album).then((tracks) => {
          if (tracks.length) actions.playFrom(tracks, 0, { context: albumContext(album) });
        });
      },
    },
    {
      label: t('albumActions.shuffle'),
      onSelect: () => {
        void albumTracks(album).then((tracks) => {
          if (tracks.length) actions.playShuffled(tracks, albumContext(album));
        });
      },
    },
  ];
  if (ctx.navigate) {
    list.push({
      label: t('albumActions.goToAlbum'),
      onSelect: () =>
        ctx.navigate!(albumPath(album.title, album.album_artist, { view: 'library', albumId: album.id })),
    });
  }
  return { title: album.title, subtitle: album.album_artist, actions: list };
}

/** Open the album menu. Pass the triggering event to anchor a cursor popover. */
export function openAlbumMenu(album: CatalogAlbum, ctx: AlbumMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(albumMenuOptions(album, ctx), ev);
}
