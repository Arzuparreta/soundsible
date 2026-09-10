import { ArtistLinks, MusicLink } from './MusicLinks';
import { albumDestination, albumMusic } from '../lib/musicNavigation';
import { For, Show } from 'solid-js';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { openAlbumMenu } from './albumActions';
import type { CatalogAlbum } from '../types/music';
import styles from './AlbumGrid.module.css';
import { coverStyle } from '../lib/cover';

/** Grid of album cards (square covers) linking to each record's detail view.
 *
 * The rows come from the engine's catalog, so a card is a record rather than a
 * title: two albums that happen to share a name are two cards, and a
 * compilation is credited to Various Artists. */
export default function AlbumGrid(props: { albums: CatalogAlbum[] }) {
  const cover = (album: CatalogAlbum) =>
    coverStyle(album.title, album.cover_track_id ? coverUrl(album.cover_track_id, 'thumb') : undefined);
  return (
    <div class={styles.grid}>
      <For each={props.albums}>
        {(album) => {
          return (
            <div
              class={styles.card}
              data-pressable
            >
              {/* One link over the whole tile, the way the search cards do it:
                * the cover, the title, the credit line and the song count are
                * all the record, so all of them open it. The artist links keep
                * their own layer above it and stay separately reachable. */}
              <Show when={album.title.trim()}>
                <MusicLink class={styles.activate} path={albumDestination(albumMusic(album))} label={album.title}
                  onMenu={(event) => openAlbumMenu(album, {}, event)} />
              </Show>
              <div class={styles.sleeve}>
                <div class={styles.cover} style={cover(album)} />
                <span class={styles.title}>{album.title}</span>
              </div>
              <ArtistLinks class={styles.artist} music={albumMusic(album)} />
              <span class={styles.count}>{trackCount(album.track_count)}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
