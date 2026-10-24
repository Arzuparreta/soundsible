import { savedEntityAction } from './savedEntityActions';
import { type ActionMenuOptions, type MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import { openContextMenu } from '../lib/contextMenu';
import { actions, state } from '../stores';
import { api } from '../lib/api';
import { tracksByIds } from '../lib/catalogTracks';
import { albumDestination, albumMusic, navigateMusic } from '../lib/musicNavigation';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import { coverUrl } from '../lib/media';
import type { CatalogAlbum, Track } from '../types/music';
import type { PlaybackContextDescriptor } from '../lib/playbackQueue';

export interface AlbumMenuContext {
  navigate?: (path: string) => void;
}

/** This record's tracks, in the order the record has them.
 *
 * Asked of the engine rather than filtered out of the library by title: which
 * songs are on a record is the catalog's answer, and matching on a name here is
 * how two records that share one end up playing as a single mixed-up album. */
async function albumTracks(album: CatalogAlbum): Promise<Track[]> {
  try {
    const { track_ids } = await api.getLibraryAlbum(album.id);
    return tracksByIds(track_ids ?? []);
  } catch {
    toast.error(t('searchPanel.noResolve'));
    return [];
  }
}

function albumContext(album: CatalogAlbum): PlaybackContextDescriptor {
  return {
    id: `album:${album.id}`,
    kind: 'album',
    label: album.title,
    cover: album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined,
    destination: albumDestination(albumMusic(album)),
  };
}

/** Play / shuffle / go-to-album menu definition for a catalog album. */
export function albumMenuOptions(album: CatalogAlbum, _ctx: AlbumMenuContext = {}): ActionMenuOptions {
  const play = async (shuffle = false) => {
    const epoch = actions.beginAutoSessionChange();
    const tracks = await albumTracks(album);
    if (!tracks.length || actions.autoSessionToken() !== epoch) return;
    if (shuffle) actions.playShuffled(tracks, albumContext(album));
    else if (state.autoMode.active) actions.startDjSelection(tracks, album.title);
    else actions.playFrom(tracks, 0, { context: albumContext(album) });
  };
  const list: MenuAction[] = [
    { icon: menuIcons.play(), label: t('albumActions.play'), onSelect: () => void play() },
    { icon: menuIcons.shuffle(), label: t('albumActions.shuffle'), onSelect: () => void play(true) },
  ];
  {
    list.push({
      icon: menuIcons.album(),
      label: t('albumActions.goToAlbum'),
      onSelect: () =>
        navigateMusic(albumDestination(albumMusic(album))),
    });
  }
  list.push(savedEntityAction({ kind: 'album', name: album.title, artist: album.album_artist, destination: albumDestination(albumMusic(album)), cover: album.cover_track_id ? coverUrl(album.cover_track_id) : undefined }));
  return { title: album.title, subtitle: album.album_artist, actions: list };
}

/** Open the album menu. Pass the triggering event to anchor a cursor popover. */
export function openAlbumMenu(album: CatalogAlbum, ctx: AlbumMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(albumMenuOptions(album, ctx), ev);
}
