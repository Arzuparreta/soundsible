import { albumPath, artistPath } from './artistRoute';
import { trackCoverUrl } from './media';
import { pickPlaylistCoverTrack } from './playlists';
import type { PlaybackContextDescriptor } from './playbackQueue';
import type { LibrarySettings, Track } from '../types/music';

/**
 * Where the queue's context card leads.
 *
 * Contexts played by this build carry their page with them, built by the view
 * that started them from the ids it had at hand. A session restored from an
 * older build has only the id and the label, and the page is worked out from
 * those — with the next song to fill in what the label cannot say, such as the
 * artist a record belongs to. A collection that has no page of its own gets no
 * destination: the card names it and leaves it at that.
 */
export function contextDestination(
  context: PlaybackContextDescriptor,
  sample?: Track | null,
): string | undefined {
  if (context.destination) return context.destination;
  const view = sample?.source === 'preview' ? 'discover' : 'library';
  switch (context.kind) {
    case 'library':
      return '/';
    case 'favourites':
      return '/favourites';
    case 'playlist': {
      const name = context.id.startsWith('playlist:') ? context.id.slice('playlist:'.length) : context.label;
      return name ? playlistDestination(name) : undefined;
    }
    case 'artist':
      return context.label ? artistPath(context.label, { view }) : undefined;
    case 'album':
      return context.label
        ? albumPath(context.label, sample?.album_artist || sample?.artist || '', {
            view,
            albumId: view === 'library' ? sample?.album_id : undefined,
            deezerId: sample?.deezer_album_id,
          })
        : undefined;
    default:
      return undefined;
  }
}

/** The page for a playlist, as the playlist views link to it. */
export function playlistDestination(name: string): string {
  return `/playlists/${encodeURIComponent(name)}`;
}

/** A playlist as a context, with the artwork its card in the grid shows. */
export function playlistContext(
  name: string,
  tracks: readonly Track[],
  settings: LibrarySettings,
): PlaybackContextDescriptor {
  const byId = new Map(tracks.map((track) => [track.id, track] as const));
  const coverTrack = pickPlaylistCoverTrack(name, tracks.map((track) => track.id), byId, settings);
  return {
    id: `playlist:${name}`,
    kind: 'playlist',
    label: name,
    destination: playlistDestination(name),
    cover: coverTrack ? trackCoverUrl(coverTrack, 'thumb') : undefined,
  };
}

/** The whole library, played from its song list. */
export function libraryContext(label: string): PlaybackContextDescriptor {
  return { id: 'library', kind: 'library', label, destination: '/' };
}

export function favouritesContext(label: string): PlaybackContextDescriptor {
  return { id: 'favourites', kind: 'favourites', label, destination: '/favourites' };
}
