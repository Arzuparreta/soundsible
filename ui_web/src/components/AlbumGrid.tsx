import { AlbumLink, ArtistLinks } from './MusicLinks';
import { albumMusic } from '../lib/musicNavigation';
import { For } from 'solid-js';
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
              <AlbumLink music={albumMusic(album)} class={styles.albumLink} onMenu={(event) => openAlbumMenu(album, {}, event)}>
                <div class={styles.cover} style={cover(album)} />
                <span class={styles.title}>{album.title}</span>
              </AlbumLink>
              <ArtistLinks class={styles.artist} music={albumMusic(album)} />
              <span class={styles.count}>{trackCount(album.track_count)}</span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
